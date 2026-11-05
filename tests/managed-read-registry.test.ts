import { expect, it, vi } from "vitest";
import { ManagedReadRegistry } from "../apps/web/src/managed-read-registry.js";

it("bounds outstanding managed reads and admits a new read only after terminal cleanup", () => {
  const registry = new ManagedReadRegistry(2);
  const first = registry.begin()!, second = registry.begin()!;
  expect(registry.count()).toBe(2);
  expect(registry.begin()).toBeNull();
  first.finish("eof");
  const replacement = registry.begin()!;
  expect(registry.count()).toBe(2);
  first.finish("eof");
  expect(registry.begin()).toBeNull();
  second.finish("terminated"); replacement.finish("eof");
  expect(registry.count()).toBe(0);
});

it("retains an indeterminate cleanup for the document lifetime", () => {
  const registry = new ManagedReadRegistry(1), lease = registry.begin()!;
  lease.finish("unknown");
  expect(registry.full()).toBe(true);
  lease.finish("eof");
  expect(registry.begin()).toBeNull();
  expect(registry.count()).toBe(1);
});

it("fails closed for malformed runtime outcomes, including a later claimed EOF", () => {
  for (const value of [undefined, null, "unexpected", {}]) {
    const registry = new ManagedReadRegistry(1), lease = registry.begin()!;
    (lease.finish as (end: unknown) => void)(value);
    lease.finish("eof");
    expect(registry.count()).toBe(1); expect(registry.begin()).toBeNull();
  }
});

it("admits exactly 32 default slots and never frees another lease on duplicate finish", () => {
  const registry = new ManagedReadRegistry();
  const leases = Array.from({ length: 32 }, () => registry.begin()!);
  expect(leases.every(Boolean)).toBe(true); expect(registry.begin()).toBeNull();
  leases[0]!.finish("terminated"); const replacement = registry.begin()!;
  leases[0]!.finish("eof"); expect(registry.begin()).toBeNull();
  replacement.finish("unknown"); replacement.finish("terminated");
  expect(registry.count()).toBe(32);
});

it("coalesces asynchronous capacity notifications without weakening synchronous admission", async () => {
  const registry = new ManagedReadRegistry(1); let notices = 0;
  const unsubscribe = registry.subscribe(() => { notices++; });
  const lease = registry.begin()!;
  expect(registry.begin()).toBeNull(); expect(notices).toBe(0);
  await Promise.resolve(); expect(notices).toBe(1);
  lease.finish("eof"); await Promise.resolve(); expect(notices).toBe(2);
  unsubscribe(); registry.begin(); await Promise.resolve(); expect(notices).toBe(2);
});

it("rejects invalid or excessive capacity settings", () => {
  for (const value of [0, -1, 1.5, 33, Infinity, NaN])
    expect(() => new ManagedReadRegistry(value)).toThrow();
});

it("coalesces admission and completion in one task while notifying a fixed subscriber snapshot", async () => {
  const registry = new ManagedReadRegistry(1); let first = 0, added = 0;
  registry.subscribe(() => { first++; registry.subscribe(() => { added++; }); });
  const lease = registry.begin()!; lease.finish("eof");
  await Promise.resolve(); expect(first).toBe(1); expect(added).toBe(0);
  registry.begin(); await Promise.resolve(); expect(first).toBe(2); expect(added).toBe(1);
});

it("notifies remaining subscribers and surfaces only a fixed error after a subscriber throws", () => {
  const tasks: VoidFunction[] = [];
  const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => { tasks.push(task); });
  try {
    const registry = new ManagedReadRegistry(1); let notified = false;
    registry.subscribe(() => { throw new Error("synthetic-private-detail"); });
    registry.subscribe(() => { notified = true; });
    registry.begin(); tasks.shift()!();
    expect(notified).toBe(true);
    expect(() => tasks.shift()!()).toThrow("Managed read subscriber failed");
  } finally { queue.mockRestore(); }
});

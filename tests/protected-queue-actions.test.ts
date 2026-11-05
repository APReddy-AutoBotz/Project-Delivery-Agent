import { expect, it } from "vitest";
import { ProtectedSessionModel } from "../apps/web/src/protected-session-model.js";
import { createPreviewStartAction, createQueueLoadAction } from "../apps/web/src/protected-queue-actions.js";

const A = "30000000-0000-4000-8000-000000000001", B = "30000000-0000-4000-8000-000000000002";
function setup() {
  const model = new ProtectedSessionModel(), session = model.establish(model.beginLogin(), "synthetic-token")!;
  const check = model.beginIdentity(session)!;
  model.finishIdentity(check, "success", { customerId: "10000000-0000-4000-8000-000000000001", subject: "person", roles: ["project_manager"] });
  const capability = model.capability(session)!, view = model.enterQueueView(capability)!;
  return { model, capability, view };
}

it("revokes unstarted queue actions and never obtains a later idle owner", () => {
  const { model, view } = setup(), idle = model.queueIdleFor(view)!;
  const abandoned = createQueueLoadAction(model, view, idle);
  expect(Object.isFrozen(abandoned.callbacks)).toBe(true); abandoned.callbacks.dispose(); expect(abandoned.callbacks.start()).toBe(false);
  expect("finish" in abandoned.callbacks).toBe(false);
  const current = createQueueLoadAction(model, view, idle); expect(current.callbacks.start()).toBe(true);
  expect(current.callbacks.start()).toBe(false); expect(current.callbacks.current()).toBe(true);
  current.callbacks.dispose();
  expect(abandoned.callbacks.start()).toBe(false); expect(current.finish([A])).toBeNull();
  const next = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  expect(next.callbacks.start()).toBe(true); expect(next.finish([A, B])).not.toBeNull();
  current.callbacks.dispose(); expect(next.callbacks.current()).toBe(true); next.callbacks.dispose(); expect(next.callbacks.current()).toBe(false);
});

it("cannot cancel a newer queue after a stale action completes or fails", () => {
  const { model, view } = setup();
  const old = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  old.callbacks.start(); const oldQueue = old.finish([A])!;
  const next = createQueueLoadAction(model, view, oldQueue); next.callbacks.start(); const current = next.finish([B])!;
  old.callbacks.dispose(); expect(model.currentQueue(current)).toBe(true); expect(next.callbacks.current()).toBe(true);
  const failing = createQueueLoadAction(model, view, current); failing.callbacks.start(); expect(failing.finish(["invalid"])).toBeNull();
  const fresh = createQueueLoadAction(model, view, model.queueIdleFor(view)!); fresh.callbacks.start(); const freshQueue = fresh.finish([A])!;
  failing.callbacks.dispose(); expect(model.currentQueue(freshQueue)).toBe(true);
});

it("revokes unstarted preview callbacks and keeps stale cleanup away from a newer turn", () => {
  const { model, view } = setup(), loader = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  loader.callbacks.start(); const queue = loader.finish([A, B])!, idle = model.previewIdleFor(queue)!;
  const abandoned = createPreviewStartAction(model, queue, idle, [A]);
  expect(Object.isFrozen(abandoned.callbacks)).toBe(true); abandoned.callbacks.dispose(); expect(abandoned.callbacks.start()).toBe(false);
  expect("snapshot" in abandoned.callbacks).toBe(false);
  const first = createPreviewStartAction(model, queue, idle, [A]); expect(first.callbacks.start()).toBe(true); const firstTurn = first.snapshot()!;
  expect(first.callbacks.start()).toBe(false); expect(first.current(firstTurn.rows[0]!)).toBe(true);
  const second = createPreviewStartAction(model, queue, firstTurn, [B]); expect(second.callbacks.start()).toBe(true); const nextTurn = second.snapshot()!;
  expect(first.snapshot()).toBeNull();
  first.callbacks.dispose(); expect(second.current(nextTurn.rows[0]!)).toBe(true);
  second.callbacks.dispose(); expect(second.current(nextTurn.rows[0]!)).toBe(false);
  expect(model.currentQueue(queue)).toBe(true);
  const stale = createPreviewStartAction(model, queue, idle, [A]); expect(stale.callbacks.start()).toBe(false);
});

it("copies a trusted preview batch before exposing its child callback", () => {
  const { model, view } = setup(), loader = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  loader.callbacks.start(); const queue = loader.finish([A, B])!, input = [A];
  const action = createPreviewStartAction(model, queue, model.previewIdleFor(queue)!, input);
  input[0] = B;
  expect(action.callbacks.start()).toBe(true);
  expect(action.snapshot()?.rows.map((row) => row.projectId)).toEqual([A]);
});

it("only exposes an empty preview snapshot while its exact turn is current", () => {
  const { model, view } = setup(), loader = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  loader.callbacks.start(); const queue = loader.finish([A])!;
  const action = createPreviewStartAction(model, queue, model.previewIdleFor(queue)!, []);
  expect(action.callbacks.start()).toBe(true); expect(action.snapshot()?.rows).toEqual([]);
  expect(model.leaveQueueView(view)).toBe(true); expect(action.snapshot()).toBeNull();
});

it("a queue disposed by a reentrant input cannot clear a newer queue", () => {
  const { model, view } = setup(), old = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  old.callbacks.start(); let later: ReturnType<typeof createQueueLoadAction> | undefined;
  const input = [A]; Object.defineProperty(input, 0, { get() {
    old.callbacks.dispose(); later = createQueueLoadAction(model, view, model.queueIdleFor(view)!); later.callbacks.start(); later.finish([B]); return A;
  } });
  expect(old.finish(input)).toBeNull(); expect(later?.callbacks.current()).toBe(true);
});

it("owner lifecycle invalidates sibling unstarted callbacks sharing the old idle", () => {
  const { model, view } = setup(), idle = model.queueIdleFor(view)!;
  const a = createQueueLoadAction(model, view, idle), b = createQueueLoadAction(model, view, idle);
  expect(model.leaveQueueView(view)).toBe(true);
  expect(a.callbacks.start()).toBe(false); expect(b.callbacks.start()).toBe(false);
});

it("owner visibility invalidation revokes all preview actions sharing the idle", () => {
  const { model, view } = setup(), loader = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  loader.callbacks.start(); const queue = loader.finish([A, B])!, idle = model.previewIdleFor(queue)!;
  const a = createPreviewStartAction(model, queue, idle, [A]), b = createPreviewStartAction(model, queue, idle, [B]);
  expect(model.cancelPreview(queue, idle)).toBe(true);
  expect(a.callbacks.start()).toBe(false); expect(b.callbacks.start()).toBe(false);
  const fresh = createPreviewStartAction(model, queue, model.previewIdleFor(queue)!, [B]);
  expect(fresh.callbacks.start()).toBe(true); const turn = fresh.snapshot()!; expect(fresh.current(turn.rows[0]!)).toBe(true);
  expect(model.leaveQueueView(view)).toBe(true); expect(fresh.snapshot()).toBeNull();
});

it("a reentrant preview batch snapshot cannot revive an invalidated queue", () => {
  const { model, view } = setup(), loader = createQueueLoadAction(model, view, model.queueIdleFor(view)!);
  loader.callbacks.start(); const queue = loader.finish([A, B])!, idle = model.previewIdleFor(queue)!;
  const input = [A]; Object.defineProperty(input, 0, { get() { model.leaveQueueView(view); return A; } });
  const action = createPreviewStartAction(model, queue, idle, input);
  expect(action.callbacks.start()).toBe(false); expect(action.snapshot()).toBeNull();
});

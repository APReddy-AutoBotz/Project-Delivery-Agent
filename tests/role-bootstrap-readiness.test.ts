import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { probeRoleBootstrapEndpoint, runRoleBootstrapWhenReady, runWithOwnedCleanup, waitForRoleBootstrapReadiness } from "../scripts/acceptance/role-bootstrap-readiness.mjs";

describe("isolated role-bootstrap TCP readiness", () => {
  it("waits for the authenticated endpoint without retrying the subsequent acceptance work", async () => {
    let time = 0;
    const probe = vi.fn().mockResolvedValueOnce("unavailable").mockResolvedValueOnce("unavailable").mockResolvedValue("ready");
    const pause = vi.fn(async (ms: number) => { time += ms; });
    const acceptance = vi.fn(async () => { throw new Error("acceptance failed"); });
    await expect(runRoleBootstrapWhenReady(probe, acceptance,
      { timeoutMs: 1000, intervalMs: 100, now: () => time, pause })).rejects.toThrow("acceptance failed");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(acceptance).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("fails at the bounded deadline without probing again or starting work", async () => {
    let time = 0;
    const probe = vi.fn().mockResolvedValue("unavailable");
    const pause = vi.fn(async (ms: number) => { time += ms; });
    const acceptance = vi.fn();
    await expect((async () => {
      await waitForRoleBootstrapReadiness(probe, { timeoutMs: 250, intervalMs: 100, now: () => time, pause });
      acceptance();
    })()).rejects.toThrow("Fresh isolated PostgreSQL TCP readiness deadline");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([100, 100, 50]);
    expect(acceptance).not.toHaveBeenCalled();
  });

  it("fails closed on endpoint identity mismatch without retrying", async () => {
    const probe = vi.fn().mockResolvedValue("mismatch");
    const pause = vi.fn();
    await expect(waitForRoleBootstrapReadiness(probe, { pause })).rejects.toThrow("Fresh isolated PostgreSQL identity mismatch");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("rejects invalid timing bounds before probing", async () => {
    const probe = vi.fn();
    await expect(waitForRoleBootstrapReadiness(probe, { timeoutMs: 0 })).rejects.toThrow("Invalid role bootstrap readiness bounds");
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not start acceptance when a late successful probe exceeds the deadline", async () => {
    let time = 0;
    const acceptance = vi.fn();
    const probe = vi.fn(async () => { time = 101; return "ready"; });
    await expect(runRoleBootstrapWhenReady(probe, acceptance, { timeoutMs: 100, now: () => time }))
      .rejects.toThrow("Fresh isolated PostgreSQL TCP readiness deadline");
    expect(acceptance).not.toHaveBeenCalled();
  });
});

describe("owned PostgreSQL readiness probe", () => {
  function client(overrides: Record<string, unknown> = {}) {
    return Object.assign(new EventEmitter(), {
      connection: { stream: { destroy: vi.fn() } },
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ database: "postgres", username: "pdaa" }] }),
      end: vi.fn().mockResolvedValue(undefined),
    }, overrides);
  }
  function constructor(instance: object) {
    return vi.fn(function () { return instance; });
  }

  it("uses and closes a fresh client for a valid authenticated query", async () => {
    const instance = client(), Client = constructor(instance);
    await expect(probeRoleBootstrapEndpoint(Client, "synthetic connection", 100)).resolves.toBe("ready");
    expect(Client).toHaveBeenCalledWith(expect.objectContaining({ connectionString: "synthetic connection", connectionTimeoutMillis: 1000, query_timeout: 1000 }));
    expect(instance.query).toHaveBeenCalledOnce();
    expect(instance.end).toHaveBeenCalledOnce();
  });

  it("does not turn an identity mismatch into a retry when cleanup fails", async () => {
    const instance = client({ query: vi.fn().mockResolvedValue({ rows: [{ database: "other", username: "pdaa" }] }),
      end: vi.fn().mockRejectedValue(new Error("private cleanup detail")) });
    await expect(probeRoleBootstrapEndpoint(constructor(instance), "synthetic connection", 100)).resolves.toBe("mismatch");
  });

  it("handles an emitted disconnect and rejects authentication failures safely", async () => {
    const disconnected = client();
    disconnected.query.mockImplementation(async () => {
      disconnected.emit("error", new Error("private socket detail"));
      return { rows: [{ database: "postgres", username: "pdaa" }] };
    });
    await expect(probeRoleBootstrapEndpoint(constructor(disconnected), "synthetic connection", 100)).resolves.toBe("unavailable");
    expect(disconnected.end).toHaveBeenCalledOnce();
    const denied = client({ connect: vi.fn().mockRejectedValue(Object.assign(new Error("private authentication detail"), { code: "28P01" })) });
    await expect(probeRoleBootstrapEndpoint(constructor(denied), "synthetic connection", 100)).resolves.toBe("failure");
    expect(denied.end).toHaveBeenCalledOnce();
  });

  it("destroys its own socket if a client refuses to close", async () => {
    const instance = client({ end: vi.fn().mockImplementation(() => new Promise(() => {})) });
    await expect(probeRoleBootstrapEndpoint(constructor(instance), "synthetic connection", 25)).resolves.toBe("unavailable");
    expect(instance.connection.stream.destroy).toHaveBeenCalledOnce();
  });

  it("preserves an authentication failure when cleanup hangs", async () => {
    const instance = client({ connect: vi.fn().mockRejectedValue(Object.assign(new Error("private authentication detail"), { code: "28P01" })),
      end: vi.fn().mockImplementation(() => new Promise(() => {})) });
    await expect(probeRoleBootstrapEndpoint(constructor(instance), "synthetic connection", 25)).resolves.toBe("failure");
    expect(instance.connection.stream.destroy).toHaveBeenCalledOnce();
  });

  it("does not retry if destroying the owned socket fails", async () => {
    const destroy = vi.fn(() => { throw new Error("private socket detail"); });
    const instance = client({ connection: { stream: { destroy } }, end: vi.fn().mockImplementation(() => new Promise(() => {})) });
    await expect(probeRoleBootstrapEndpoint(constructor(instance), "synthetic connection", 25)).resolves.toBe("failure");
    expect(destroy).toHaveBeenCalledOnce();
  });
});

it("retains the original failure if owned-container cleanup also fails", async () => {
  const initial = new Error("original acceptance failure");
  const report = vi.fn();
  await expect(runWithOwnedCleanup(async () => { throw initial; }, async () => { throw new Error("cleanup failure"); }, report))
    .rejects.toBe(initial);
  expect(report).toHaveBeenCalledOnce();
  await expect(runWithOwnedCleanup(async () => "passed", async () => { throw new Error("cleanup failure"); }, report))
    .rejects.toThrow("cleanup failure");
});

import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { watchCommits } from "../scripts/acceptance/reconciliation-commit-probes.mjs";

// NFR-REL-001/002: transport ordering controls, not native PostgreSQL evidence.
// Native guard, PID and rollback acceptance remains separately mandatory.
afterEach(() => vi.useRealTimers());
function fixture() {
  const record = {
    nativeCommitAttempts: 0,
    callbackReturned: true,
    pid: 31,
    sessionUser: "pdaa_api",
    commitObserver: undefined as unknown,
    commitObserverFailure: undefined as string | undefined,
    native: undefined as unknown,
    unsupportedTransport: undefined as boolean | undefined,
  };
  const pool = new EventEmitter();
  const connection = new EventEmitter();
  const native = vi.fn();
  const client = Object.assign(new EventEmitter(), {
    connection,
    processID: 31,
    query: native,
  });
  const observer = {
    processID: 32,
    query: vi.fn().mockResolvedValue({
      rows: [{ pid: 31, usename: "pdaa_api", state: "idle", query: "COMMIT" }],
    }),
  };
  watchCommits(
    pool,
    () => record,
    () => observer,
  );
  pool.emit("connect", client);
  const cleaned = () => {
    expect(connection.listenerCount("readyForQuery")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("end")).toBe(0);
  };
  return { record, native, client, connection, observer, cleaned };
}
it("waits after native rejection for the actual idle event and preserves the exact error", async () => {
  const f = fixture();
  const error = Object.assign(new Error("Expected deferred guard"), {
    code: "P0001",
  });
  f.native.mockRejectedValue(error);
  const args = { text: "COMMIT", values: [] };
  const pending = f.client.query(args);
  const assertion = expect(pending).rejects.toBe(error);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.observer.query).not.toHaveBeenCalled();
  expect(f.record.commitObserver).toBeUndefined();
  f.connection.emit("readyForQuery", { status: "I" });
  await assertion;
  expect(f.native).toHaveBeenCalledExactlyOnceWith(args);
  expect(f.record.nativeCommitAttempts).toBe(1);
  expect(f.record.native).toMatchObject({
    code: "P0001",
    message: error.message,
  });
  expect(f.record.commitObserver).toMatchObject({
    writerPid: 31,
    observerPid: 32,
    state: "idle",
    phase: "native-commit-settled",
  });
  f.cleaned();
});
it("does not miss synchronous readiness and returns the original positive result", async () => {
  const f = fixture(),
    value = { command: "COMMIT" };
  f.native.mockImplementation(() => {
    f.connection.emit("readyForQuery", { status: "I" });
    return Promise.resolve(value);
  });
  expect(await f.client.query(" COMMIT; ")).toBe(value);
  expect(f.native).toHaveBeenCalledExactlyOnceWith(" COMMIT; ");
  f.cleaned();
});
it("does not impose the drain timeout while native COMMIT is still running", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    value = { command: "COMMIT" };
  let resolveNative!: (value: { command: string }) => void;
  f.native.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveNative = resolve;
      }),
  );
  const pending = f.client.query("COMMIT");
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.record.commitObserverFailure).toBeUndefined();
  expect(f.observer.query).not.toHaveBeenCalled();
  f.connection.emit("readyForQuery", { status: "I" });
  resolveNative(value);
  expect(await pending).toBe(value);
  f.cleaned();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["T", "E", undefined])(
  "rejects non-idle ready status %s",
  async (status) => {
    const f = fixture();
    f.native.mockResolvedValue({ command: "COMMIT" });
    const pending = f.client.query("COMMIT");
    f.connection.emit("readyForQuery", { status });
    await expect(pending).rejects.toThrow(
      "COMMIT did not reach ReadyForQuery idle",
    );
    expect(f.record.commitObserverFailure).toBe("ready-status");
    expect(f.observer.query).not.toHaveBeenCalled();
    f.cleaned();
  },
);
it("fails closed at the fixed observation budget with no readiness event", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.native.mockResolvedValue({ command: "COMMIT" });
  const pending = f.client.query("COMMIT");
  const assertion = expect(pending).rejects.toThrow(
    "COMMIT did not reach ReadyForQuery idle",
  );
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(f.record.commitObserverFailure).toBe("ready-timeout");
  expect(f.record.commitObserver).toBeUndefined();
  expect(f.observer.query).not.toHaveBeenCalled();
  f.cleaned();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["error", "end"])(
  "fails closed and drains listeners on transport %s",
  async (event) => {
    const f = fixture();
    f.native.mockResolvedValue({ command: "COMMIT" });
    const pending = f.client.query("COMMIT");
    f.client.emit(event);
    await expect(pending).rejects.toThrow(
      "COMMIT did not reach ReadyForQuery idle",
    );
    expect(f.record.commitObserverFailure).toBe(`ready-transport-${event}`);
    expect(f.observer.query).not.toHaveBeenCalled();
    f.cleaned();
  },
);
it.each([
  ["pid", 999, "observer-writer-pid"],
  ["usename", "other", "observer-session-user"],
  ["state", "active", "observer-idle"],
  ["query", "ROLLBACK", "observer-commit-query"],
] as const)(
  "retains independent observer rejection for wrong %s after readiness",
  async (field, value, phase) => {
    const f = fixture();
    f.native.mockResolvedValue({ command: "COMMIT" });
    f.observer.query.mockResolvedValue({
      rows: [
        {
          pid: 31,
          usename: "pdaa_api",
          state: "idle",
          query: "COMMIT",
          [field]: value,
        },
      ],
    });
    const pending = f.client.query("COMMIT");
    f.connection.emit("readyForQuery", { status: "I" });
    await expect(pending).rejects.toThrow();
    expect(f.record.commitObserverFailure).toBe(phase);
    expect(f.record.commitObserver).toBeUndefined();
    f.cleaned();
  },
);
it("preserves native and observer errors together without attesting success", async () => {
  const f = fixture(),
    nativeError = new Error("guard"),
    observerError = new Error("observer");
  f.native.mockRejectedValue(nativeError);
  f.observer.query.mockRejectedValue(observerError);
  const pending = f.client.query("COMMIT");
  f.connection.emit("readyForQuery", { status: "I" });
  await expect(pending).rejects.toMatchObject({
    errors: [nativeError, observerError],
    cause: observerError,
  });
  expect(f.record.commitObserverFailure).toBe("observer-query");
  expect(f.record.commitObserver).toBeUndefined();
  f.cleaned();
});
it("cannot reuse the preceding COMMIT readiness on the same backend", async () => {
  const f = fixture();
  f.native.mockResolvedValue({ command: "COMMIT" });
  const first = f.client.query("COMMIT");
  f.connection.emit("readyForQuery", { status: "I" });
  await first;
  f.cleaned();
  f.record.commitObserver = undefined;
  f.observer.query.mockClear();
  const second = f.client.query("COMMIT");
  await Promise.resolve();
  expect(f.observer.query).not.toHaveBeenCalled();
  expect(f.record.commitObserver).toBeUndefined();
  f.connection.emit("readyForQuery", { status: "I" });
  await second;
  expect(f.native).toHaveBeenCalledTimes(2);
  expect(f.observer.query).toHaveBeenCalledTimes(1);
  f.cleaned();
});
it("cleans up synchronous native errors and unsupported non-promise transports", () => {
  const f = fixture(),
    error = new Error("synchronous failure");
  f.native.mockImplementationOnce(() => {
    throw error;
  });
  expect(() => f.client.query("COMMIT")).toThrow(error);
  f.cleaned();
  f.native.mockReturnValue(null);
  expect(f.client.query("COMMIT")).toBeNull();
  expect(f.record.unsupportedTransport).toBe(true);
  expect(f.record.commitObserver).toBeUndefined();
  f.cleaned();
});
it("forwards non-COMMIT statements without observing or altering them", async () => {
  const f = fixture(),
    value = { command: "ROLLBACK" };
  f.native.mockResolvedValue(value);
  expect(await f.client.query("ROLLBACK")).toBe(value);
  expect(f.record.nativeCommitAttempts).toBe(0);
  expect(f.observer.query).not.toHaveBeenCalled();
  f.cleaned();
});

import { describe, expect, it, vi } from "vitest";
import { bindSessionRequest } from "../apps/web/src/session-bound-request.js";
import type { RequestFn } from "../apps/web/src/request-types.js";

describe("SEC-AUTH-001 session-bound requests", () => {
  it("forwards a current request and its exact arguments", async () => {
    const underlying = vi.fn(async () => ({ ok: true }));
    const request = bindSessionRequest(underlying as RequestFn, () => true);
    const init = { method: "POST", body: "{}" };
    const unavailable = vi.fn();
    await expect(request("/projects", init, 1024, unavailable)).resolves.toEqual({ ok: true });
    expect(underlying).toHaveBeenCalledOnce();
    const [path, actualInit, limit, callback, , current] = underlying.mock.calls[0] as unknown as Parameters<RequestFn>;
    expect([path, actualInit, limit]).toEqual(["/projects", init, 1024]);
    expect(current?.()).toBe(true);
    callback?.(true);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not dispatch an old callback after a same-token session replacement", async () => {
    let generation = 1;
    const issuedGeneration = generation;
    const underlying = vi.fn();
    const request = bindSessionRequest(underlying as RequestFn, () => generation === issuedGeneration);
    const completion = vi.fn();
    generation++;
    await expect(request("/projects", {}, undefined, undefined, { current: () => true, completion })).rejects.toThrow("before this request started");
    expect(underlying).not.toHaveBeenCalled();
    expect(completion).toHaveBeenCalledExactlyOnceWith("terminated");
  });

  it("rejects a success that finishes after the issuing session ended", async () => {
    let generation = 1;
    let finish!: (value: unknown) => void;
    const underlying = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const request = bindSessionRequest(underlying as RequestFn, () => generation === 1);
    const result = request("/projects");
    generation++;
    finish({ id: "old" });
    await expect(result).rejects.toThrow("before this request completed");
  });

  it("fails closed if the session predicate fails", async () => {
    const underlying = vi.fn();
    const request = bindSessionRequest(underlying as RequestFn, () => { throw new Error("predicate failed"); });
    await expect(request("/projects")).rejects.toThrow("before this request started");
    expect(underlying).not.toHaveBeenCalled();
  });

  it("suppresses late unavailable callbacks and replaces a stale rejection", async () => {
    let live = true;
    let reject!: (reason: Error) => void;
    let notify!: (denied?: boolean) => void;
    let effects!: () => boolean;
    const underlying: RequestFn = <T>(_path: string, _init?: RequestInit, _limit?: number,
      unavailable?: (denied?: boolean) => void, _managed?: Parameters<RequestFn>[4], current?: () => boolean) => {
      notify = unavailable!; effects = current!;
      return new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise; });
    };
    const unavailable = vi.fn();
    const request = bindSessionRequest(underlying, () => live);
    const result = request("/projects", {}, 1024, unavailable);
    expect(effects()).toBe(true);
    notify(true);
    expect(unavailable).toHaveBeenCalledOnce();
    live = false;
    expect(effects()).toBe(false);
    notify(true);
    reject(Object.assign(new Error("old status"), { status: 403 }));
    await expect(result).rejects.toThrow("before this request completed");
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it("rechecks the session after a reentrant effects predicate", async () => {
    let live = true;
    const unavailable = vi.fn();
    const underlying: RequestFn = async <T>(_path: string, _init?: RequestInit, _limit?: number,
      callback?: (denied?: boolean) => void) => { callback?.(true); return undefined as T; };
    const request = bindSessionRequest(underlying, () => live);
    await expect(request("/projects", {}, 1024, unavailable, undefined, () => { live = false; return true; }))
      .rejects.toThrow("before this request completed");
    expect(unavailable).not.toHaveBeenCalled();
  });
});

import { expect, it, vi } from "vitest";
import { ProtectedQueueTransport } from "../apps/web/src/protected-queue-transport.js";
import { ProtectedSessionModel } from "../apps/web/src/protected-session-model.js";
import { createPmQueueResource } from "../apps/web/src/pm-queue-resource.js";
import type { ValidatedQueueMembership } from "../apps/web/src/protected-queue-response.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const body = JSON.stringify({ rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
  approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" }, projects: [], items: [] });
function login(model: ProtectedSessionModel) {
  const session = model.establish(model.beginLogin(), "synthetic-token")!;
  model.finishIdentity(model.beginIdentity(session)!, "success", { customerId, subject: "synthetic-pm", roles: ["project_manager"] });
  const capability = model.capability(session)!, view = model.enterQueueView(capability)!;
  return { session, capability, view };
}
function setup() {
  const model = new ProtectedSessionModel(), identity = login(model), transport = new ProtectedQueueTransport();
  const current = vi.fn(() => true), unavailable = vi.fn(), sessionExpired = vi.fn();
  return { model, transport, ...identity, handlers: { current, unavailable, sessionExpired } };
}
function heldResponse(status = 200) {
  let close!: (text?: string) => void, closed = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    close = (text = "") => { if (closed) return; closed = true; if (text) controller.enqueue(new TextEncoder().encode(text)); controller.close(); };
  } });
  return { response: new Response(stream, { status }), close: (text?: string) => close(text) };
}
function fakeFetch(implementation: () => Promise<Response>) {
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => implementation()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

it("issues one fixed authorized GET, consumes its original response and returns its validated snapshot", async () => {
  const { model, transport, capability, view, handlers } = setup(), fetcher = fakeFetch(async () => new Response(body));
  const operation = transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fetcher);
  const result = await operation.run();
  expect(result?.snapshot.projects).toEqual([]); expect(result && model.currentQueue(result.queue)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe("/api/pm/action-queue"); expect(init).toEqual({ method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-token" } });
  expect(init.signal).toBeUndefined(); expect(transport.occupied()).toBe(false);
  expect(await operation.run()).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
});

it("holds a single physical slot across cancellation, view replacement and the original body", async () => {
  const { model, transport, capability, view, handlers } = setup(), held = heldResponse(), signal = new AbortController();
  const fetcher = fakeFetch(async () => held.response);
  const first = transport.create(model, capability, view, model.queueIdleFor(view)!, signal.signal, handlers, fetcher).run();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(transport.occupied()).toBe(true); signal.abort();
  expect(model.leaveQueueView(view)).toBe(true); const nextView = model.enterQueueView(capability)!;
  const nextFetch = fakeFetch(async () => new Response(body));
  const blocked = transport.create(model, capability, nextView, model.queueIdleFor(nextView)!, new AbortController().signal, handlers, nextFetch);
  expect(await blocked.run()).toBeNull(); expect(nextFetch).not.toHaveBeenCalled(); expect(transport.occupied()).toBe(true);
  held.close(body); expect(await first).toBeNull(); expect(transport.occupied()).toBe(false);
  const fresh = transport.create(model, capability, nextView, model.queueIdleFor(nextView)!, new AbortController().signal, handlers, nextFetch);
  expect(await fresh.run()).not.toBeNull(); expect(nextFetch).toHaveBeenCalledTimes(1);
});

it("notifies the trusted owner when physical queue capacity changes", async () => {
  const { model, transport, capability, view, handlers } = setup(), held = heldResponse(), listener = vi.fn();
  const unsubscribe = transport.subscribe(listener), initial = transport.snapshot();
  const pending = transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => held.response)).run();
  try {
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(transport.snapshot()).toBeGreaterThan(initial); expect(transport.occupied()).toBe(true);
    held.close(body); expect(await pending).not.toBeNull();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(transport.occupied()).toBe(false);
  } finally { held.close(); unsubscribe(); }
});

it("does not report a false capacity release after an indeterminate fetch failure", async () => {
  const { model, transport, capability, view, handlers } = setup(), listener = vi.fn();
  const unsubscribe = transport.subscribe(listener), fetcher = fakeFetch(() => Promise.reject(new Error("synthetic network failure")));
  try {
    const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fetcher).run();
    expect(result).toBeNull(); await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    const afterFailure = transport.snapshot(); expect(transport.occupied()).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(transport.snapshot()).toBe(afterFailure); expect(listener).toHaveBeenCalledTimes(1);
    const retryFetch = fakeFetch(async () => new Response(body));
    expect(await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, retryFetch).run()).toBeNull();
    expect(retryFetch).not.toHaveBeenCalled(); expect(transport.occupied()).toBe(true);
  } finally { unsubscribe(); }
});

it("expires the issuing session on a late 401 before the held original error body ends", async () => {
  const { model, transport, capability, session, view, handlers } = setup();
  let respond!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => { respond = resolve; }), fetcher = fakeFetch(() => gate);
  const pending = transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fetcher).run();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(model.leaveQueueView(view)).toBe(true); const held = heldResponse(401); respond(held.response);
  await vi.waitFor(() => expect(handlers.sessionExpired).toHaveBeenCalledExactlyOnceWith(session));
  expect(model.current(capability)).toBe(false); expect(transport.occupied()).toBe(true);
  held.close("{}"); expect(await pending).toBeNull(); expect(transport.occupied()).toBe(false);
});

it("does not let an old 401 expire a new session with the same bearer", async () => {
  const { model, transport, capability, view, handlers } = setup();
  let respond!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => { respond = resolve; }), fetcher = fakeFetch(() => gate);
  const pending = transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fetcher).run();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const replacement = login(model); respond(new Response("{}", { status: 401 }));
  expect(await pending).toBeNull(); expect(model.current(replacement.capability)).toBe(true);
  expect(handlers.sessionExpired).not.toHaveBeenCalled(); expect(transport.occupied()).toBe(false);
});

it("invalidates only a current queue at 403/404 headers and drains the held original body", async () => {
  for (const status of [403, 404]) {
    const { model, transport, capability, view, handlers } = setup(), held = heldResponse(status), fetcher = fakeFetch(async () => held.response);
    const oldIdle = model.queueIdleFor(view)!;
    const pending = transport.create(model, capability, view, oldIdle, new AbortController().signal, handlers, fetcher).run();
    await vi.waitFor(() => expect(handlers.unavailable).toHaveBeenCalledTimes(1));
    expect(model.current(capability)).toBe(true); expect(model.beginQueue(view, oldIdle)).toBeNull();
    expect(transport.occupied()).toBe(true); held.close("{}"); expect(await pending).toBeNull();
    expect(transport.occupied()).toBe(false); expect(handlers.sessionExpired).not.toHaveBeenCalled();
  }
});

it("keeps unknown stream or fetch failures occupied but distinguishes confirmed terminal bodies", async () => {
  for (const make of [() => Promise.resolve(new Response(null, { status: 200 })), () => Promise.reject(new Error("synthetic network"))]) {
    const { model, transport, capability, view, handlers } = setup();
    const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fakeFetch(make)).run();
    expect(result).toBeNull(); expect(transport.occupied()).toBe(true); expect(handlers.unavailable).toHaveBeenCalledTimes(1);
  }
  for (const response of [new Response(null, { status: 204 }), new Response(new Uint8Array([0xff])), new Response(new Uint8Array(2 * 1024 * 1024 + 1))]) {
    const { model, transport, capability, view, handlers } = setup();
    const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fakeFetch(async () => response)).run();
    expect(result).toBeNull(); expect(transport.occupied()).toBe(false); expect(handlers.unavailable).toHaveBeenCalledTimes(1);
  }
});

it("does not dispatch canceled or cross-session operations", async () => {
  const { model, transport, capability, view, handlers } = setup(), fetcher = fakeFetch(async () => new Response(body));
  const aborted = new AbortController(); aborted.abort();
  expect(await transport.create(model, capability, view, model.queueIdleFor(view)!, aborted.signal, handlers, fetcher).run()).toBeNull();
  const replacement = login(model);
  expect(await transport.create(model, capability, view, model.queueIdleFor(replacement.view)!, new AbortController().signal, handlers, fetcher).run()).toBeNull();
  expect(fetcher).not.toHaveBeenCalled(); expect(transport.occupied()).toBe(false);
});

it("reports malformed current 200s once and keeps newer queue state safe", async () => {
  const alpha = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", upper = alpha.toUpperCase();
  const duplicate = JSON.stringify({ rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
    approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" },
    projects: [upper, alpha].map((projectId) => ({ projectId, name: "P", schedule: { projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY", sourceAuthority: "NOT_ASSESSED", approvalItems: "UNAVAILABLE", rankPolicyRevision: "advice-core@1", asOf: "2026-10-21T11:00:00.000Z", items: [] },
      update: { projectId, audience: "project_manager", availability: "UNCONFIGURED", approvalItems: "UNAVAILABLE", asOf: "2026-10-21T11:00:00.000Z" },
      blockerAge: { projectId, audience: "project_manager", ruleRevision: "blocker-age@1", orderRevision: "blocker-review-order@1", timeZone: "UTC", asOf: "2026-10-21T11:00:00.000Z", coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, items: [] } })), items: [] });
  for (const invalid of ["{", JSON.stringify({ projects: [] }), duplicate]) {
    const { model, transport, capability, view, handlers } = setup(), fetcher = fakeFetch(async () => new Response(invalid));
    expect(await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fetcher).run()).toBeNull();
    expect(handlers.unavailable).toHaveBeenCalledTimes(1); expect(transport.occupied()).toBe(false);
    expect(model.queueIdleFor(view)).not.toBeNull();
  }
});

it("a superseded 200 or 503 cannot notify or mint while its original body settles", async () => {
  for (const [status, content] of [[200, body], [200, "{"], [503, "{}"]] as const) {
    const { model, transport, capability, view, handlers } = setup(), held = heldResponse(status);
    let respond!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => { respond = resolve; }), fetcher = fakeFetch(() => gate);
    const pending = transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fetcher).run();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    handlers.current.mockReturnValue(false); respond(held.response); held.close(content);
    expect(await pending).toBeNull(); expect(handlers.unavailable).not.toHaveBeenCalled();
    expect(transport.occupied()).toBe(false); expect(model.queueIdleFor(view)).not.toBeNull();
  }
});

it("rechecks scope when the trusted current predicate itself navigates", async () => {
  const { model, transport, capability, view, handlers } = setup(), fetcher = fakeFetch(async () => new Response(body));
  handlers.current.mockImplementation(() => { model.leaveQueueView(view); return true; });
  const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers, fetcher).run();
  expect(result).toBeNull(); expect(fetcher).not.toHaveBeenCalled(); expect(handlers.unavailable).not.toHaveBeenCalled();
  expect(transport.occupied()).toBe(false);
});

it("a failure notification cannot clear a newer queue started by its handler", async () => {
  const { model, transport, capability, view, handlers } = setup();
  let newer: ReturnType<ProtectedSessionModel["finishQueue"]> = null;
  handlers.unavailable.mockImplementation(() => {
    const check = model.beginQueue(view, model.queueIdleFor(view)!)!;
    newer = model.finishQueue(check, []);
  });
  const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => new Response("{"))).run();
  expect(result).toBeNull(); expect(handlers.unavailable).toHaveBeenCalledTimes(1);
  expect(newer).not.toBeNull(); expect(model.currentQueue(newer!)).toBe(true); expect(transport.occupied()).toBe(false);
});

it("does not free a slot after a stream error with rejected cancellation", async () => {
  const { model, transport, capability, view, handlers } = setup();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic break")); },
    cancel() { return Promise.reject(new Error("synthetic cancel failure")); } });
  const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => new Response(stream))).run();
  expect(result).toBeNull(); expect(handlers.unavailable).toHaveBeenCalledTimes(1); expect(transport.occupied()).toBe(true);
});

it("still drains a 401 after an expiry callback throws", async () => {
  const { model, transport, capability, view, handlers } = setup(), held = heldResponse(401);
  handlers.sessionExpired.mockImplementation(() => { throw new Error("synthetic callback failure"); });
  const pending = transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => held.response)).run();
  await vi.waitFor(() => expect(handlers.sessionExpired).toHaveBeenCalledTimes(1));
  expect(transport.occupied()).toBe(true); held.close("{}");
  expect(await pending).toBeNull(); expect(transport.occupied()).toBe(false); expect(model.current(capability)).toBe(false);
});

it("announces an oversized current response before a held cancellation finishes", async () => {
  const { model, transport, capability, view, handlers } = setup(); let release!: () => void;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { return new Promise<void>((resolve) => { release = resolve; }); } });
  const pending = transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => new Response(stream))).run();
  await vi.waitFor(() => expect(handlers.unavailable).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(release).toBeDefined()); expect(transport.occupied()).toBe(true);
  release(); expect(await pending).toBeNull(); expect(transport.occupied()).toBe(false);
});

it("keeps the physical slot when oversized-stream cancellation rejects", async () => {
  const { model, transport, capability, view, handlers } = setup();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { return Promise.reject(new Error("synthetic cancellation failure")); } });
  const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => new Response(stream))).run();
  expect(result).toBeNull(); expect(handlers.unavailable).toHaveBeenCalledTimes(1); expect(transport.occupied()).toBe(true);
});

it("accepts a UTF-8 character split across original stream chunks", async () => {
  const { model, transport, capability, view, handlers } = setup();
  const withUnicode = body.replace('"projects":[]', '"note":"é","projects":[]');
  const bytes = new TextEncoder().encode(withUnicode), split = bytes.findIndex((byte) => byte === 0xc3);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, split + 1)); controller.enqueue(bytes.slice(split + 1)); controller.close();
  } });
  const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => new Response(stream))).run();
  expect(result?.snapshot.projects).toEqual([]); expect(transport.occupied()).toBe(false);
  expect(handlers.unavailable).not.toHaveBeenCalled();
});

it("accepts an original queue body exactly at the encoded-byte limit", async () => {
  const { model, transport, capability, view, handlers } = setup(), maximum = 2 * 1024 * 1024;
  const text = body + " ".repeat(maximum - new TextEncoder().encode(body).byteLength);
  const result = await transport.create(model, capability, view, model.queueIdleFor(view)!, new AbortController().signal, handlers,
    fakeFetch(async () => new Response(text))).run();
  expect(result?.snapshot.projects).toEqual([]); expect(transport.occupied()).toBe(false);
  expect(handlers.unavailable).not.toHaveBeenCalled();
});

it("coalesces a superseded 403, 404 or 503 until the original drains before starting its replacement", async () => {
  for (const status of [403, 404, 503]) {
    const { model, transport, capability, view, handlers } = setup(), held = heldResponse(status);
    let firstHeaders!: (value: Response) => void, secondHeaders!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { firstHeaders = resolve; });
    const second = new Promise<Response>((resolve) => { secondHeaders = resolve; });
    let calls = 0;
    const fetcher = fakeFetch(() => ++calls === 1 ? first : second);
    const states: string[] = []; let active: ReturnType<ProtectedQueueTransport["create"]> | undefined;
    let headerSeen!: () => void;
    const processedHeaders = new Promise<void>((resolve) => { headerSeen = resolve; });
    Object.defineProperty(held.response, "status", { get() { headerSeen(); return status; } });
    const driver: ReturnType<typeof createPmQueueResource<ValidatedQueueMembership>> = createPmQueueResource<ValidatedQueueMembership>({
      visible: () => true,
      publish: (state) => { if (state.phase === "loading") active?.dispose(); states.push(state.phase); },
      load: async (signal) => {
        const idle = model.queueIdleFor(view); if (!idle) throw new Error("Queue unavailable");
        const operation = transport.create(model, capability, view, idle, signal,
          { ...handlers, current: () => driver.current(signal) }, fetcher);
        active = operation;
        const result = await operation.run(); if (!result) throw new Error("Queue unavailable");
        return result;
      },
    });
    try {
      driver.refresh(); await vi.waitFor(() => expect(calls).toBe(1));
      driver.refresh(); expect(states.at(-1)).toBe("loading");
      firstHeaders(held.response); await processedHeaders;
      await vi.waitFor(() => expect(held.response.body?.locked).toBe(true));
      expect(transport.occupied()).toBe(true); expect(calls).toBe(1);
      expect(handlers.unavailable).not.toHaveBeenCalled();
      held.close("{}"); await vi.waitFor(() => expect(calls).toBe(2));
      expect(states.at(-1)).toBe("loading"); expect(handlers.unavailable).not.toHaveBeenCalled();
      secondHeaders(new Response(body)); await vi.waitFor(() => expect(states.at(-1)).toBe("ready"));
      expect(transport.occupied()).toBe(false); expect(calls).toBe(2);
    } finally { try { held.close(); firstHeaders(held.response); secondHeaders(new Response(body)); } finally { active?.dispose(); driver.dispose(); } }
  }
});

it("a refresh after a successful queue synchronously invalidates its prior preview before a new read", async () => {
  const { model, transport, capability, view, handlers } = setup();
  const projectId = "30000000-0000-4000-8000-000000000001", asOf = "2026-10-21T11:00:00.000Z";
  const project = { projectId, name: "Synthetic", schedule: { projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY", sourceAuthority: "NOT_ASSESSED",
    approvalItems: "UNAVAILABLE", rankPolicyRevision: "advice-core@1", asOf, items: [] },
    update: { projectId, audience: "project_manager", availability: "UNCONFIGURED", approvalItems: "UNAVAILABLE", asOf },
    blockerAge: { projectId, audience: "project_manager", ruleRevision: "blocker-age@1", orderRevision: "blocker-review-order@1", timeZone: "UTC", asOf,
      coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, items: [] } };
  const oneProject = JSON.stringify({ rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
    approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" }, projects: [project], items: [] });
  let secondResponse!: (response: Response) => void, calls = 0;
  const second = new Promise<Response>((resolve) => { secondResponse = resolve; });
  const fetcher = fakeFetch(() => ++calls === 1 ? Promise.resolve(new Response(oneProject)) : second);
  let active: ReturnType<ProtectedQueueTransport["create"]> | undefined, latest: ValidatedQueueMembership | undefined;
  const states: string[] = [];
  const driver: ReturnType<typeof createPmQueueResource<ValidatedQueueMembership>> = createPmQueueResource<ValidatedQueueMembership>({
    visible: () => true,
    publish: (state) => { if (state.phase === "loading") active?.dispose(); if (state.phase === "ready") latest = state.data; states.push(state.phase); },
    load: async (signal) => {
      const idle = model.queueIdleFor(view); if (!idle) throw new Error("Queue unavailable");
      active = transport.create(model, capability, view, idle, signal, { ...handlers, current: () => driver.current(signal) }, fetcher);
      const result = await active.run(); if (!result) throw new Error("Queue unavailable"); return result;
    },
  });
  try {
    driver.refresh(); await vi.waitFor(() => expect(states.at(-1)).toBe("ready"));
    const first = latest!, turn = model.beginPreview(first.queue, model.previewIdleFor(first.queue)!, [projectId])!;
    expect(model.currentPreviewRow(first.queue, turn, turn.rows[0]!)).toBe(true);
    driver.refresh();
    expect(states.at(-1)).toBe("loading"); expect(model.currentQueue(first.queue)).toBe(false);
    expect(model.currentPreviewRow(first.queue, turn, turn.rows[0]!)).toBe(false);
    await vi.waitFor(() => expect(calls).toBe(2)); secondResponse(new Response(oneProject));
    await vi.waitFor(() => expect(states.at(-1)).toBe("ready"));
    expect(latest).not.toBe(first); expect(latest && model.currentQueue(latest.queue)).toBe(true);
  } finally { secondResponse(new Response(oneProject)); active?.dispose(); driver.dispose(); }
});

it("a current queue denial reaches the driver owner before its held error body ends", async () => {
  for (const status of [403, 404]) {
    const { model, transport, capability, view, handlers } = setup(), held = heldResponse(status), phases: string[] = [];
    const fetcher = fakeFetch(async () => held.response);
    let active: ReturnType<ProtectedQueueTransport["create"]> | undefined;
    const driver: ReturnType<typeof createPmQueueResource<ValidatedQueueMembership>> = createPmQueueResource<ValidatedQueueMembership>({
      visible: () => true,
      publish: (state) => { if (state.phase === "loading") active?.dispose(); phases.push(state.phase); },
      load: async (signal) => {
        const idle = model.queueIdleFor(view); if (!idle) throw new Error("Queue unavailable");
        active = transport.create(model, capability, view, idle, signal,
          { ...handlers, current: () => driver.current(signal), unavailable: () => { phases.push("header-unavailable"); } }, fetcher);
        const result = await active.run(); if (!result) throw new Error("Queue unavailable"); return result;
      },
    });
    try {
      driver.refresh(); await vi.waitFor(() => expect(phases.at(-1)).toBe("header-unavailable"));
      await vi.waitFor(() => expect(held.response.body?.locked).toBe(true));
      expect(transport.occupied()).toBe(true); expect(model.current(capability)).toBe(true);
      held.close("{}"); await vi.waitFor(() => expect(phases.at(-1)).toBe("error"));
      expect(transport.occupied()).toBe(false);
    } finally { try { held.close(); } finally { active?.dispose(); driver.dispose(); } }
  }
});

it("a dirty queue's 401 still expires the same issuing session before body EOF", async () => {
  const { model, transport, capability, session, view, handlers } = setup(), held = heldResponse(401);
  let respond!: (value: Response) => void, calls = 0;
  const first = new Promise<Response>((resolve) => { respond = resolve; }), fetcher = fakeFetch(() => { calls++; return first; });
  const phases: string[] = []; let active: ReturnType<ProtectedQueueTransport["create"]> | undefined;
  const driver: ReturnType<typeof createPmQueueResource<ValidatedQueueMembership>> = createPmQueueResource<ValidatedQueueMembership>({
    visible: () => true,
    publish: (state) => { if (state.phase === "loading") active?.dispose(); phases.push(state.phase); },
    load: async (signal) => {
      const idle = model.queueIdleFor(view); if (!idle) throw new Error("Queue unavailable");
      active = transport.create(model, capability, view, idle, signal, { ...handlers, current: () => driver.current(signal) }, fetcher);
      const result = await active.run(); if (!result) throw new Error("Queue unavailable"); return result;
    },
  });
  try {
    driver.refresh(); await vi.waitFor(() => expect(calls).toBe(1)); driver.refresh(); respond(held.response);
    await vi.waitFor(() => expect(handlers.sessionExpired).toHaveBeenCalledExactlyOnceWith(session));
    expect(model.current(capability)).toBe(false); expect(transport.occupied()).toBe(true);
    held.close("{}"); await vi.waitFor(() => expect(phases.at(-1)).toBe("error"));
    expect(calls).toBe(1); expect(transport.occupied()).toBe(false);
  } finally { try { held.close(); respond(held.response); } finally { active?.dispose(); driver.dispose(); } }
});

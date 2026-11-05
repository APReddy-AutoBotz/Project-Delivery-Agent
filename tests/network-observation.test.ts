import { describe, expect, it } from "vitest";
import { createNetworkObservation } from "../scripts/acceptance/network-observation.mjs";

const origin = "https://product.example.test";
const request = (id: string, path = "/api/projects") => ({ requestId: id, request: { url: origin + path, method: "GET" } });
const pause = (id: string, path = "/api/projects") => ({ networkId: id, request: { url: origin + path, method: "GET" } });

describe("bounded passive CDP network diagnostics", () => {
  it("keeps independent same-path requests separate and emits only fixed categories", () => {
    const canary = "private-network-id-and-query-canary", d = createNetworkObservation(origin);
    d.request(request(canary, `/api/projects?private=${canary}`)); d.request(request("other"));
    d.response({ requestId: canary, response: { status: 200 } }); d.pause(pause(canary));
    d.body(canary, "started"); d.body(canary, "resolved"); d.continuation(canary, "started"); d.continuation(canary, "resolved");
    d.finished({ requestId: "other" }); d.failed({ requestId: canary, canceled: true, errorText: canary });
    expect(d.snapshot()).toEqual({ status: "cdp-failure-observed", playwrightMatch: "unknown", hopMatch: "unknown", resource: "project_list", response: "2xx", responseAtFailure: "2xx", pause: "observed", pauseAtFailure: "observed",
      body: "resolved", bodyAtFailure: "resolved", continuation: "resolved", continuationAtFailure: "resolved",
      recorderFail: "none", recorderFailAtFailure: "none", terminal: "failed", canceled: "yes", failure: "other" });
    expect(JSON.stringify(d.snapshot())).not.toContain(canary);
  });

  it("reports unknown and incomplete observations without guessing a match", () => {
    const d = createNetworkObservation(origin);
    expect(d.snapshot()).toEqual({ status: "none-observed" });
    d.pause(pause("missing"));
    expect(d.snapshot()).toEqual({ status: "incomplete" });
    const missing = createNetworkObservation(origin);
    missing.request({ request: { url: origin + "/api/me", method: "GET" } });
    expect(missing.snapshot()).toEqual({ status: "incomplete" });
    const earlyFailure = createNetworkObservation(origin);
    earlyFailure.failed({ requestId: "not-yet-observed", canceled: true });
    earlyFailure.request(request("not-yet-observed"));
    expect(earlyFailure.snapshot()).toEqual({ status: "incomplete" });
    const unresolved = createNetworkObservation(origin);
    unresolved.response({ requestId: "orphan", response: { status: 200 } });
    expect(unresolved.snapshot()).toEqual({ status: "incomplete" });
  });

  it("fails diagnostic attribution closed for redirects, repeated IDs and reordered states", () => {
    for (const mutate of [
      (d: ReturnType<typeof createNetworkObservation>) => d.request(request("one", "/different")),
      (d: ReturnType<typeof createNetworkObservation>) => { d.pause(pause("one")); d.pause(pause("one")); },
      (d: ReturnType<typeof createNetworkObservation>) => d.body("one", "started"),
      (d: ReturnType<typeof createNetworkObservation>) => d.continuation("one", "started"),
      (d: ReturnType<typeof createNetworkObservation>) => d.body("one", "resolved"),
      (d: ReturnType<typeof createNetworkObservation>) => { d.response({ requestId: "one", response: { status: 200 } }); d.response({ requestId: "one", response: { status: 200 } }); },
    ]) {
      const d = createNetworkObservation(origin); d.request(request("one")); mutate(d); d.failed({ requestId: "one", canceled: false });
      expect(d.snapshot()).toEqual({ status: "ambiguous" });
    }
    const redirected = createNetworkObservation(origin);
    redirected.request({ ...request("one"), redirectResponse: {} }); redirected.failed({ requestId: "one" });
    expect(redirected.snapshot()).toEqual({ status: "ambiguous" });
  });

  it("uses bounded capacity and reports multiple failures or unavailable diagnostics", () => {
    const d = createNetworkObservation(origin, 1); d.request(request("one")); d.request(request("two"));
    d.failed({ requestId: "one" }); expect(d.snapshot()).toEqual({ status: "overflow" });
    const many = createNetworkObservation(origin); many.request(request("one")); many.request(request("two"));
    many.failed({ requestId: "one" }); many.failed({ requestId: "two" }); expect(many.snapshot()).toEqual({ status: "incomplete" });
    many.unavailable(); expect(many.snapshot()).toEqual({ status: "unavailable" });
    expect(() => createNetworkObservation(origin, 513)).toThrow("Invalid diagnostic capacity");
  });

  it("remains bounded and useful after many unrelated completed requests", () => {
    const d = createNetworkObservation(origin);
    for (let index = 0; index < 128; index++) {
      const id = `unrelated-${index}`;
      d.request(request(id, "/asset")); d.response({ requestId: id, response: { status: 200 } }); d.finished({ requestId: id });
    }
    d.request(request("target")); d.failed({ requestId: "target", canceled: true, errorText: "net::ERR_ABORTED" });
    expect(d.snapshot()).toMatchObject({ status: "cdp-failure-observed", failure: "aborted", playwrightMatch: "unknown" });
  });

  it("retains observed command states at failure separately from later completion", () => {
    const d = createNetworkObservation(origin); d.request(request("one")); d.pause(pause("one"));
    d.body("one", "started"); d.continuation("one", "started"); d.failed({ requestId: "one", canceled: true });
    d.body("one", "resolved"); d.continuation("one", "resolved"); d.recorderFail("one");
    expect(d.snapshot()).toMatchObject({ status: "cdp-failure-observed", playwrightMatch: "unknown", body: "resolved",
      bodyAtFailure: "started", continuation: "resolved", continuationAtFailure: "started", recorderFail: "attempted", recorderFailAtFailure: "none" });
  });

  it("marks optional CDP activation unavailable until enabled, and never revives a failure", () => {
    const d = createNetworkObservation(origin); d.pending(); expect(d.snapshot()).toEqual({ status: "unavailable" });
    d.enabled(); expect(d.snapshot()).toEqual({ status: "none-observed" });
    d.pending(); d.unavailable(); d.enabled(); expect(d.snapshot()).toEqual({ status: "unavailable" });
    const gap = createNetworkObservation(origin); gap.pending(); gap.requestObserved(); gap.enabled();
    expect(gap.snapshot()).toEqual({ status: "incomplete" });
  });

  it("marks early or reused network IDs ambiguous and distinguishes later events", () => {
    for (const first of ["finished", "response"]) {
      const d = createNetworkObservation(origin);
      if (first === "finished") d.finished({ requestId: "one" });
      else d.response({ requestId: "one", response: { status: 200 } });
      d.request(request("one")); d.failed({ requestId: "one", canceled: true });
      expect(d.snapshot()).toEqual({ status: "ambiguous" });
    }
    const redirected = createNetworkObservation(origin);
    redirected.request(request("one", "/unrelated")); redirected.finished({ requestId: "one" });
    redirected.request(request("one")); redirected.failed({ requestId: "one" });
    expect(redirected.snapshot()).toEqual({ status: "ambiguous" });
    const later = createNetworkObservation(origin); later.request(request("one")); later.failed({ requestId: "one" });
    later.response({ requestId: "one", response: { status: 200 } }); later.pause(pause("one"));
    expect(later.snapshot()).toMatchObject({ status: "cdp-failure-observed", responseAtFailure: "unknown", pauseAtFailure: "none",
      response: "2xx", pause: "observed", playwrightMatch: "unknown" });
  });

  it("contains hostile event accessors and does not serialize their contents", () => {
    const canary = "hostile-network-event-canary", d = createNetworkObservation(origin);
    expect(() => d.request({ get requestId(): never { throw new Error(canary); } })).not.toThrow();
    expect(d.snapshot()).toEqual({ status: "incomplete" });
    expect(JSON.stringify(d.snapshot())).not.toContain(canary);
    const oversized = createNetworkObservation(origin);
    oversized.request({ requestId: "one", request: { url: origin + "/api/projects?" + canary.repeat(200), method: "GET" } });
    expect(oversized.snapshot()).toEqual({ status: "incomplete" });
    expect(JSON.stringify(oversized.snapshot())).not.toContain(canary);
  });
});

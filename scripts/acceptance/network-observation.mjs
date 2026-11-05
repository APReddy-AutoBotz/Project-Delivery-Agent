// Optional, passive CDP diagnostics. This is not an acceptance signal: CDP
// Network IDs do not identify Playwright Request objects, and a captured body
// does not establish application EOF or permit a failed GET to pass.
export function createNetworkObservation(origin, limit = 512) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 512) throw new Error("Invalid diagnostic capacity");
  const records = new Map();
  const ignored = new Set(), orphans = new Map();
  let availability = "ready", incomplete = false, overflow = false, failedId;
  const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 256;
  const resource = (value, method) => {
    if (method !== "GET" || typeof value !== "string") return null;
    if (value.length > 4096) throw new Error("Diagnostic URL exceeds bound");
    const url = new URL(value);
    if (url.origin !== origin) return null;
    return url.pathname === "/api/me" ? "identity" : url.pathname === "/api/projects" ? "project_list"
      : url.pathname === "/api/project-setup" ? "project_setup" : null;
  };
  const recordFor = (id) => validId(id) ? records.get(id) : undefined;
  const safe = (work) => { try { work(); } catch { incomplete = true; } };
  const room = () => records.size + ignored.size + orphans.size < limit;
  const orphan = (id, terminal) => {
    if (!validId(id)) { incomplete = true; return; }
    const prior = orphans.get(id);
    if (prior) { prior.terminal ||= terminal; return; }
    if (!room()) { overflow = true; return; }
    orphans.set(id, { terminal });
  };
  return Object.freeze({
    pending() { if (availability === "ready") availability = "pending"; },
    enabled() { if (availability === "pending") availability = "ready"; },
    unavailable() { availability = "unavailable"; },
    requestObserved() { if (availability === "pending") incomplete = true; },
    request(event) { safe(() => {
      const id = event?.requestId;
      if (validId(id) && records.has(id)) { records.get(id).ambiguous = true; return; }
      const wasIgnored = validId(id) && ignored.delete(id), prior = validId(id) ? orphans.get(id) : undefined;
      if (prior) orphans.delete(id);
      const request = event?.request, route = resource(request?.url, request?.method);
      if (!route) {
        // Retain a bounded tombstone: a later redirect may reuse this ID.
        if (validId(id)) { if (!room()) overflow = true; else ignored.add(id); }
        return;
      }
      if (!validId(id)) { incomplete = true; return; }
      if (!room()) { overflow = true; return; }
      records.set(id, { resource: route, ambiguous: Boolean(prior || wasIgnored || event?.redirectResponse), response: "unknown", responseSeen: false, pause: "none",
        body: "none", continuation: "none", recorderFail: "none", terminal: "none", canceled: "unknown" });
    }); },
    response(event) { safe(() => {
      const id = event?.requestId, record = recordFor(id);
      if (!record) { if (!ignored.has(id)) orphan(id, false); return; }
      const status = event?.response?.status;
      if (record.responseSeen) { record.ambiguous = true; return; }
      record.responseSeen = true;
      record.response = Number.isInteger(status) && status >= 100 && status < 600 ? status >= 200 && status < 300 ? "2xx" : "other" : "unknown";
    }); },
    pause(event) { safe(() => {
      const route = resource(event?.request?.url, event?.request?.method); if (!route) return;
      const record = recordFor(event?.networkId);
      if (!record) { incomplete = true; return; }
      if (record.resource !== route || record.pause !== "none") { record.ambiguous = true; return; }
      record.pause = "observed";
    }); },
    body(id, state) { safe(() => {
      const record = recordFor(id); if (!record) return;
      if (record.pause !== "observed" || (state === "started" && record.body !== "none") ||
          ((state === "resolved" || state === "failure") && record.body !== "started") ||
          !["started", "resolved", "failure"].includes(state)) { record.ambiguous = true; return; }
      record.body = state;
    }); },
    continuation(id, state) { safe(() => {
      const record = recordFor(id); if (!record) return;
      if (record.pause !== "observed" || (state === "started" && record.continuation !== "none") ||
          ((state === "resolved" || state === "failure") && record.continuation !== "started") ||
          !["started", "resolved", "failure"].includes(state)) { record.ambiguous = true; return; }
      record.continuation = state;
    }); },
    recorderFail(id) { safe(() => { const record = recordFor(id); if (record) record.recorderFail = "attempted"; }); },
    finished(event) { safe(() => {
      const id = event?.requestId, record = recordFor(id);
      if (!record) { if (!ignored.has(id)) orphan(id, true); return; }
      if (record.terminal !== "none") { record.ambiguous = true; return; }
      record.terminal = "finished";
    }); },
    failed(event) { safe(() => {
      const id = event?.requestId, record = recordFor(id);
      if (!record) { incomplete = true; return; }
      if (record.terminal !== "none" || (failedId !== undefined && failedId !== id)) { record.ambiguous = true; incomplete = true; return; }
      failedId = id;
      record.terminal = "failed";
      record.responseAtFailure = record.response;
      record.pauseAtFailure = record.pause;
      record.bodyAtFailure = record.body;
      record.continuationAtFailure = record.continuation;
      record.recorderFailAtFailure = record.recorderFail;
      const canceled = event?.canceled;
      record.canceled = canceled === true ? "yes" : canceled === false ? "no" : "unknown";
      const errorText = event?.errorText;
      record.failure = errorText === "net::ERR_ABORTED" ? "aborted" : typeof errorText === "string" ? "other" : "unknown";
    }); },
    snapshot() {
      if (availability !== "ready") return { status: "unavailable" };
      if (overflow) return { status: "overflow" };
      if (incomplete || orphans.size) return { status: "incomplete" };
      const record = recordFor(failedId);
      if (!record) return { status: "none-observed" };
      if (record.ambiguous) return { status: "ambiguous" };
      return { status: "cdp-failure-observed", playwrightMatch: "unknown", hopMatch: "unknown", resource: record.resource, response: record.response,
        responseAtFailure: record.responseAtFailure, pause: record.pause, pauseAtFailure: record.pauseAtFailure,
        body: record.body, bodyAtFailure: record.bodyAtFailure, continuation: record.continuation,
        continuationAtFailure: record.continuationAtFailure, recorderFail: record.recorderFail, recorderFailAtFailure: record.recorderFailAtFailure,
        terminal: record.terminal, canceled: record.canceled, failure: record.failure };
    },
  });
}

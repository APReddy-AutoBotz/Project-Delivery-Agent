import type { RequestFn } from "./request-types.js";
import { ManagedReadRegistry } from "./managed-read-registry.js";
import { managedRead } from "./managed-read.js";
import { previewPath, type PreviewRequestFactory } from "./pm-reconciliation-preview.js";

// The caller is the trusted queue/preview owner; this adapter cannot establish
// server authorization. Each signal mints one operation per panel instance.
export function createPreviewRequestFactory(options: {
  queueCurrent: () => boolean; projectIds: readonly string[]; request: RequestFn;
  registry: ManagedReadRegistry; issuedSignals: WeakSet<AbortSignal>;
}): PreviewRequestFactory {
  const members = new Set(options.projectIds);
  return (operation, signal, operationCurrent) => {
    const current = () => {
      try { return options.queueCurrent() && !signal.aborted && operationCurrent() === true && !signal.aborted && options.queueCurrent(); }
      catch { return false; }
    };
    if (options.issuedSignals.has(signal)) throw new Error("Preview is unavailable.");
    options.issuedSignals.add(signal);
    if (!current()) throw new Error("Preview is unavailable.");
    const allowed = new Set<string>();
    if (operation.kind === "batch") {
      const projectIds = [...operation.projectIds];
      if (projectIds.length < 1 || projectIds.length > 5 || new Set(projectIds).size !== projectIds.length ||
          projectIds.some((projectId) => !members.has(projectId))) throw new Error("Preview is unavailable.");
      for (const projectId of projectIds) {
        allowed.add(previewPath(projectId, "milestone")); allowed.add(previewPath(projectId, "scalar"));
      }
    } else if (operation.kind === "page" && members.has(operation.projectId)) {
      allowed.add(previewPath(operation.projectId, operation.category, operation.after));
    } else throw new Error("Preview is unavailable.");
    if (!current()) throw new Error("Preview is unavailable.");
    const used = new Set<string>();
    return async (path, init, onUnavailable) => {
      if (!current() || !allowed.has(path) || used.has(path)) throw new Error("Preview is unavailable.");
      used.add(path);
      if (init.signal !== signal || Object.keys(init).some((key) => key !== "signal") || !current()) throw new Error("Preview is unavailable.");
      try {
        const result = await managedRead(options.registry, signal, current, (live, completion) =>
          options.request<unknown>(path, { redirect: "error" }, 65_536, (denied) => { if (live()) onUnavailable(denied); },
            { current: live, completion }, live, 200));
        if (!current()) throw new Error("Preview is unavailable.");
        return result;
      } catch {
        throw new Error("Preview is unavailable.");
      }
    };
  };
}

// Unwired, trusted local response decoder for a future PM-queue dispatcher.
// It cannot prove the origin or completion of transport: the trusted caller
// must associate these bytes with its exact original GET and preserve its
// physical request lifetime and server authorization checks.
import { decodePmQueue } from "./pm-queue-decoder.js";
import type { PmActionQueue } from "@pdaa/domain";
import { createQueueLoadAction } from "./protected-queue-actions.js";
import { ProtectedSessionModel, type QueueCapability, type QueueCheck, type QueueIdle, type QueueView } from "./protected-session-model.js";

const maxQueueBytes = 2 * 1024 * 1024;
type ProjectLabel = Readonly<{ projectId: string; name: string }>;
type DeepReadonly<T> = T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[] :
  T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;
// The existing presentation decoder permits fields it does not inspect.
// The full snapshot is coordinator-only and is not a sanitized log payload.
export type ValidatedQueueMembership = Readonly<{ queue: QueueCapability; projects: readonly ProjectLabel[]; snapshot: DeepReadonly<PmActionQueue> }>;

// JSON.parse produces an acyclic data-only tree. Iteration avoids making the
// JavaScript call stack proportional to nesting in an untrusted response.
function freezeJsonTree(root: object): void {
  const pending: object[] = [root];
  while (pending.length) {
    const item = pending.pop()!;
    for (const value of Object.values(item)) if (value !== null && typeof value === "object") pending.push(value);
    Object.freeze(item);
  }
}

// Only the trusted coordinator may call complete; children receive callbacks.
// Text is an already-complete original response. A future transport must enforce
// its own byte cap before materializing it and report cancellation separately.
export function createQueueResponseCoordinator(model: ProtectedSessionModel, view: QueueView,
  expected: QueueIdle | QueueCheck | QueueCapability, onUnavailable: () => void = () => {}) {
  const action = createQueueLoadAction(model, view, expected);
  let completed = false;
  return Object.freeze({
    callbacks: action.callbacks,
    complete(status: unknown, text: unknown): ValidatedQueueMembership | null {
      if (completed || !action.callbacks.current()) return null;
      completed = true;
      try {
        // Raw-body cap is deliberately no looser than the existing reserialized
        // decoder cap. Whitespace/escaping may make it stricter for the wire.
        if (status !== 200 || typeof text !== "string" || text.length > maxQueueBytes ||
            new TextEncoder().encode(text).byteLength > maxQueueBytes) throw new Error("Queue unavailable");
        const decoded = decodePmQueue(JSON.parse(text));
        freezeJsonTree(decoded);
        const projects = decoded.projects.map(({ projectId, name }) => Object.freeze({ projectId, name }));
        if (!action.callbacks.current()) return null;
        // The queue decoder uses case-sensitive IDs, while the model rejects
        // case-colliding database identities; detect that while still current.
        if (new Set(projects.map((project) => project.projectId.toLowerCase())).size !== projects.length)
          throw new Error("Queue unavailable");
        const queue = action.finish(projects.map((project) => project.projectId));
        if (!queue || !action.callbacks.current()) return null;
        return Object.freeze({ queue, projects: Object.freeze(projects), snapshot: decoded });
      } catch {
        // Only the still-current check may be canceled by its failure.
        if (action.callbacks.current()) {
          try { onUnavailable(); } catch { /* The exact action is still cleared. */ }
          action.callbacks.dispose();
        }
        return null;
      }
    },
  });
}

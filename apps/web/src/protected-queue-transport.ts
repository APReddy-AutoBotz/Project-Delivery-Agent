// Unwired trusted transport for the PM queue. It does not establish server
// authorization, revoke already returned data, or prove recorder capture.
// Keep exactly one owner at App lifetime; recreating it on mount would defeat
// its physical single-flight bound across navigation and logical cancellation.
import { readBoundedUtf8Text, discardResponse } from "./bounded-json.js";
import { ManagedReadRegistry } from "./managed-read-registry.js";
import { managedRead } from "./managed-read.js";
import { createQueueResponseCoordinator, type ValidatedQueueMembership } from "./protected-queue-response.js";
import { ProtectedSessionModel, type ProtectedCapability, type QueueCapability, type QueueCheck,
  type QueueIdle, type QueueView, type Session } from "./protected-session-model.js";

const maxQueueBytes = 2 * 1024 * 1024;
type Handlers = Readonly<{ current: () => boolean; unavailable: () => void; sessionExpired: (session: Session) => void }>;

export class ProtectedQueueTransport {
  private readonly registry = new ManagedReadRegistry(1);
  readonly occupied = (): boolean => this.registry.full();
  readonly subscribe = (listener: () => void): (() => void) => this.registry.subscribe(listener);
  readonly snapshot = (): number => this.registry.snapshot();

  // This is a trusted-owner API: children never receive model, capabilities,
  // bearer credentials, fetch, handler internals or response completion.
  create(model: ProtectedSessionModel, capability: ProtectedCapability, view: QueueView,
    expected: QueueIdle | QueueCheck | QueueCapability, signal: AbortSignal,
    handlers: Handlers, fetchOriginal: typeof fetch = fetch) {
    const session = model.currentQueueView(view) && view.capability === capability && model.current(capability) ? capability.session : null;
    const thisRegistry = this.registry;
    let attempted = false, notified = false;
    const valid = () => Boolean(session) && model.currentQueueView(view) && view.capability === capability && model.current(capability) &&
      coordinator.callbacks.current() && !signal.aborted;
    const current = () => {
      if (!valid()) return false;
      try { if (handlers.current() !== true) return false; } catch { return false; }
      // The trusted predicate may synchronously invalidate its own scope.
      return valid();
    };
    const unavailable = () => {
      if (notified || !current()) return;
      notified = true;
      coordinator.callbacks.dispose();
      try { handlers.unavailable(); } catch { /* A callback cannot skip cleanup. */ }
    };
    const coordinator = createQueueResponseCoordinator(model, view, expected, unavailable);
    return Object.freeze({
      // Logical revocation is synchronous; the original request and physical
      // slot remain owned until actual body handling has settled.
      dispose(): void { coordinator.callbacks.dispose(); },
      async run(): Promise<ValidatedQueueMembership | null> {
        if (attempted || signal.aborted || !session || !model.currentQueueView(view) ||
            view.capability !== capability || !model.current(capability)) return null;
        attempted = true;
        if (!coordinator.callbacks.start()) return null;
        let published = false;
        try {
          const result = await managedRead(thisRegistry, signal, current, async (live, report) => {
            const credential = model.protectedCredential(capability);
            if (!credential || !live()) { report("terminated"); throw new Error("Queue unavailable"); }
            // No logical abort signal is passed to an already issued request.
            const response = await fetchOriginal("/api/pm/action-queue", {
              method: "GET", redirect: "error", headers: { Authorization: "Bearer " + credential },
            });
            // Session-level 401 is checked even when the issuing queue is old.
            if (response.status === 401 && model.expire(session)) {
              try { handlers.sessionExpired(session); } catch { /* Still consume the original body. */ }
            }
            if (response.status !== 200) {
              unavailable(); await discardResponse(response, report); throw new Error("Queue unavailable");
            }
            const text = await readBoundedUtf8Text(response, maxQueueBytes, report, unavailable);
            if (!live()) throw new Error("Queue unavailable");
            const value = coordinator.complete(200, text);
            if (!value) { unavailable(); throw new Error("Queue unavailable"); }
            return value;
          });
          if (!current()) return null;
          published = true; return result;
        } catch { unavailable(); return null; }
        finally { if (!published) coordinator.callbacks.dispose(); }
      },
    });
  }
}

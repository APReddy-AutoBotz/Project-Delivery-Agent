// Synthetic local-only browser fixture; not an application entry or authority.
import { ProtectedSessionModel, type ProtectedCapability, type QueueView, type Session } from "../src/protected-session-model.js";
import { ProtectedQueueTransport } from "../src/protected-queue-transport.js";
import { createPmQueueResource } from "../src/pm-queue-resource.js";
import type { ValidatedQueueMembership } from "../src/protected-queue-response.js";

const model = new ProtectedSessionModel(), transport = new ProtectedQueueTransport();
const output = document.querySelector<HTMLOutputElement>("#state")!, settledOutput = document.querySelector<HTMLOutputElement>("#settled")!;
const driverOutput = document.querySelector<HTMLOutputElement>("#driver-state")!;
let session: Session, capability: ProtectedCapability, view: QueueView | null;
let visible = true, settled = 0, active: ReturnType<ProtectedQueueTransport["create"]> | null = null;
let signal: AbortController | null = null;
let driver: ReturnType<typeof createPmQueueResource<ValidatedQueueMembership>> | null = null;
let driverActive: ReturnType<ProtectedQueueTransport["create"]> | null = null;
const setState = (value: string) => { output.textContent = value; };
function establish() {
  session = model.establish(model.beginLogin(), "synthetic-fixture-token")!;
  model.finishIdentity(model.beginIdentity(session)!, "success", {
    customerId: "10000000-0000-4000-8000-000000000001", subject: "synthetic-pm", roles: ["project_manager"],
  });
  capability = model.capability(session)!; view = model.enterQueueView(capability); visible = true; setState("idle");
}
function leave() {
  visible = false; signal?.abort(); active?.dispose(); driverActive?.dispose(); driver?.dispose(); driver = null;
  if (view) model.leaveQueueView(view);
  active = null; view = null; driverOutput.textContent = "hidden"; setState("hidden");
}
function startDriver() {
  if (driver || !visible || !view || !model.current(capability)) return;
  const issuedView = view, issuedSession = session, issuedCapability = capability;
  const resource: ReturnType<typeof createPmQueueResource<ValidatedQueueMembership>> = createPmQueueResource<ValidatedQueueMembership>({
    visible: () => visible,
    publish: (state) => {
      if (state.phase === "loading") driverActive?.dispose();
      driverOutput.textContent = state.phase;
    },
    load: async (caller) => {
      const idle = model.queueIdleFor(issuedView); if (!idle) throw new Error("Queue unavailable");
      const operation = transport.create(model, issuedCapability, issuedView, idle, caller, {
        current: () => driver === resource && visible && view === issuedView && session === issuedSession && resource.current(caller),
        unavailable: () => { if (driver === resource && visible) driverOutput.textContent = "unavailable"; },
        sessionExpired: (expired) => { if (session === expired) { visible = false; driverOutput.textContent = "expired"; } },
      });
      driverActive = operation; const result = await operation.run();
      if (!result) throw new Error("Queue unavailable"); return result;
    },
  });
  driver = resource; resource.refresh();
}
function start() {
  if (!visible || !view || !model.current(capability)) return;
  const issuedView = view, issuedSession = session, idle = model.queueIdleFor(issuedView);
  if (!idle) return;
  signal = new AbortController(); const caller = signal;
  const operation: ReturnType<ProtectedQueueTransport["create"]> = transport.create(model, capability, issuedView, idle, caller.signal, {
    current: () => visible && view === issuedView && session === issuedSession && active === operation,
    unavailable: () => { if (active === operation && visible) setState("unavailable"); },
    sessionExpired: (expired) => { if (session === expired) { visible = false; setState("expired"); } },
  });
  active = operation; setState("loading");
  void operation.run().then((result) => {
    if (active === operation && visible) setState(result ? "ready" : "unavailable");
  }).finally(() => { settledOutput.textContent = String(++settled); });
}
document.querySelector("#start")!.addEventListener("click", start);
document.querySelector("#hide")!.addEventListener("click", leave);
document.querySelector("#show")!.addEventListener("click", () => {
  if (!model.current(capability)) return;
  view = model.enterQueueView(capability); visible = Boolean(view); if (visible) setState("idle");
});
document.querySelector("#new-session")!.addEventListener("click", () => {
  signal?.abort(); active?.dispose(); driverActive?.dispose(); driver?.dispose(); driver = null; active = null;
  driverOutput.textContent = "idle"; establish();
});
document.querySelector("#driver-start")!.addEventListener("click", startDriver);
document.querySelector("#driver-refresh")!.addEventListener("click", () => driver?.refresh());
establish();

import type { UnrankedMilestoneObservation } from "@pdaa/domain";
import { startUnrankedFreshnessClock } from "./unranked-milestone-freshness.js";

type State = { phase: "idle" | "loading" | "error" } | { phase: "ready"; data: UnrankedMilestoneObservation };
type Clock = { wall: () => number; monotonic: () => number };
type Pending = { controller: AbortController; token: number; deadline: ReturnType<typeof setTimeout>; timedOut: boolean; unavailable: boolean };
const maxDelay = 2147483647;
const expiredState: State = Object.freeze({ phase: "error" });

// Unused local driver. The caller supplies a bounded, strictly decoded load,
// owns scope/session clearing and disposal, and must hide or revalidate on browser events.
// It does not establish current source access or policy after the as-of read.
export function createUnrankedMilestoneResource(options: {
  load: (signal: AbortSignal) => Promise<UnrankedMilestoneObservation>;
  publish: (state: State) => void;
  clock?: Clock;
}) {
  let live = true, visible = true, requested = false, queued = false, generation = 0;
  let state: State = { phase: "idle" }, pending: Pending | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let freshness: ReturnType<ReturnType<typeof startUnrankedFreshnessClock>["bind"]> | undefined;
  let hiddenFreshness: typeof freshness;
  const publish = (next: State) => { state = next; if (live) options.publish(next); };
  const clearExpiry = () => { if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined; freshness = undefined; };
  const expire = () => { requested = false; hiddenFreshness = undefined; clearExpiry(); publish({ phase: "error" }); };
  const scheduleExpiry = () => {
    if (!live || !visible || !freshness || state.phase !== "ready") return;
    const left = freshness.remaining();
    if (left <= 0) { expire(); return; }
    expiryTimer = setTimeout(scheduleExpiry, Math.min(left, maxDelay));
  };
  const begin = () => {
    if (!live || !visible || pending) return;
    const token = generation, controller = new AbortController(), clock = startUnrankedFreshnessClock(options.clock);
    const active: Pending = { controller, token, timedOut: false, unavailable: false, deadline: setTimeout(() => {
      if (!live || pending !== active) return;
      active.timedOut = true; generation++; queued = false; requested = false; controller.abort();
      clearExpiry(); if (visible && state.phase !== "error") publish({ phase: "error" });
    }, 30000) };
    pending = active;
    void Promise.resolve().then(() => {
      if (!live || !visible || pending !== active || token !== generation || controller.signal.aborted) throw new Error("Read canceled");
      return options.load(controller.signal);
    }).then((value) => {
      if (!live || !visible || pending !== active || active.timedOut || token !== generation) return;
      const guard = clock.bind(value.asOf, value.positions.flatMap((position) => position.supports.map((support) => support.versionValidUntil)));
      if (guard.remaining() <= 0) { expire(); return; }
      freshness = guard; publish({ phase: "ready", data: value }); scheduleExpiry();
    }).catch(() => {
      if (live && visible && pending === active && !active.timedOut && token === generation) {
        requested = false; publish({ phase: "error" });
      }
    }).finally(() => {
      clearTimeout(active.deadline);
      if (pending !== active) return;
      pending = undefined;
      if (live && visible && queued && !active.timedOut) { queued = false; begin(); }
    });
  };
  const refresh = () => {
    if (!live || !visible) return;
    requested = true; generation++; hiddenFreshness = undefined; clearExpiry();
    if (pending?.timedOut || pending?.unavailable) { queued = false; requested = false; publish({ phase: "error" }); return; }
    publish({ phase: "loading" });
    if (pending) { queued = true; pending.controller.abort(); return; }
    begin();
  };
  const setVisible = (next: boolean) => {
    if (!live || visible === next) return;
    visible = next;
    if (!visible) {
      hiddenFreshness = state.phase === "ready" ? freshness : undefined;
      generation++; queued = false; clearExpiry(); pending?.controller.abort(); publish({ phase: "idle" });
    } else {
      const hiddenExpired = hiddenFreshness && hiddenFreshness.remaining() <= 0;
      hiddenFreshness = undefined;
      if (hiddenExpired) expire(); else if (requested) refresh();
    }
  };
  const current = (): State => {
    if (state.phase === "ready" && (!visible || !freshness || freshness.remaining() <= 0)) return expiredState;
    return state;
  };
  // Call from lifecycle events, not render; current() never publishes.
  const check = () => { if (live && state.phase === "ready" && current().phase === "error") expire(); };
  const revalidate = () => {
    if (!live || !visible) return;
    check();
    if (requested) refresh();
  };
  // A known denial or stream failure must clear the view immediately, even if
  // the response body or its cancellation has not yet settled.
  const unavailable = (signal: AbortSignal) => {
    if (!live || !visible || !pending || pending.controller.signal !== signal || pending.token !== generation || pending.timedOut || pending.unavailable) return;
    pending.unavailable = true; generation++; queued = false; requested = false;
    clearExpiry(); publish({ phase: "error" });
  };
  const dispose = () => {
    if (!live) return;
    live = false; generation++; queued = false; hiddenFreshness = undefined; clearExpiry();
    if (pending) { clearTimeout(pending.deadline); pending.controller.abort(); }
    state = { phase: "idle" };
  };
  return { refresh, setVisible, current, check, revalidate, unavailable, dispose };
}

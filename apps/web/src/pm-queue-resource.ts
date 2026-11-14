// EXEC-026 / NFR-SEC-001: at most one request per mounted scope. Invalidating
// an in-flight result hides it and schedules one fresh read after it settles.
export type PmQueueResourceState<T> = { phase: "loading" } | { phase: "ready"; data: T } | { phase: "error" };
export type ReadReserve = () => { current: () => boolean; release: () => void } | null;

export function createPmQueueResource<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  publish: (state: PmQueueResourceState<T>) => void;
  visible: () => boolean;
  reserve?: ReadReserve;
  settled?: () => void;
}) {
  let live = true, pending = false, dirty = false, timedOut = false;
  let controller: AbortController | undefined;
  let reservation: { current: () => boolean; release: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (live) timer = setTimeout(() => { if (options.visible()) refresh(); else schedule(); }, 30000);
  };
  const reservationCurrent = () => {
    if (!options.reserve) return true;
    try { return reservation?.current() === true; } catch { return false; }
  };
  // Header callbacks from superseded reads must not overwrite the loading
  // state of their queued replacement. Denial handling remains in the caller.
  const current = (signal: AbortSignal) => live && pending && !dirty && !timedOut &&
    controller?.signal === signal && !signal.aborted && reservationCurrent();
  const releaseReservation = () => {
    const old = reservation; reservation = null; old?.release();
  };
  const start = () => {
    pending = true; dirty = false; timedOut = false;
    const active = new AbortController(); controller = active;
    deadline = setTimeout(() => {
      timedOut = true; dirty = false; active.abort(); releaseReservation();
      if (live) options.publish({ phase: "error" });
    }, 30000);
    void Promise.resolve().then(() => {
      if (!live || timedOut || active.signal.aborted || !reservationCurrent()) throw new Error("Read is no longer current");
      return options.load(active.signal);
    }).then((value) => {
      if (live && !dirty && !timedOut && reservationCurrent()) options.publish({ phase: "ready", data: value });
    }, () => {
      if (live && !dirty && !timedOut && reservationCurrent()) options.publish({ phase: "error" });
    }).finally(() => {
      if (deadline !== undefined) clearTimeout(deadline);
      deadline = undefined; pending = false; controller = undefined;
      if (!live) { releaseReservation(); return; }
      if (dirty && !timedOut && reservationCurrent()) start();
      else { dirty = false; releaseReservation(); schedule(); }
      options.settled?.();
    });
  };
  const refresh = () => {
    if (!live) return;
    clearTimer();
    if (pending && timedOut) { options.publish({ phase: "error" }); return; }
    if (pending) {
      if (!reservationCurrent()) { options.publish({ phase: "error" }); return; }
      dirty = true; options.publish({ phase: "loading" }); return;
    }
    if (options.reserve) {
      try { reservation = options.reserve(); } catch { reservation = null; }
      if (!reservation || !reservationCurrent()) { releaseReservation(); options.publish({ phase: "error" }); return; }
    }
    start(); options.publish({ phase: "loading" });
  };
  const dispose = () => {
    live = false; clearTimer();
    if (deadline !== undefined) clearTimeout(deadline);
    controller?.abort(); releaseReservation();
  };
  const unavailable = (signal: AbortSignal) => { if (current(signal)) options.publish({ phase: "error" }); };
  return { refresh, dispose, current, unavailable, pending: () => pending, timedOut: () => timedOut };
}

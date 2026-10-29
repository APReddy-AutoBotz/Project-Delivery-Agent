// EXEC-026 / NFR-SEC-001: at most one request per mounted scope. Invalidating
// an in-flight result hides it and schedules one fresh read after it settles.
export type PmQueueResourceState<T> = { phase: "loading" } | { phase: "ready"; data: T } | { phase: "error" };

export function createPmQueueResource<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  publish: (state: PmQueueResourceState<T>) => void;
  visible: () => boolean;
}) {
  let live = true, pending = false, dirty = false, timedOut = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (live) timer = setTimeout(() => { if (options.visible()) refresh(); else schedule(); }, 30000);
  };
  const refresh = () => {
    if (!live) return;
    clearTimer();
    if (pending && timedOut) { options.publish({ phase: "error" }); return; }
    options.publish({ phase: "loading" });
    if (pending) { dirty = true; return; }
    pending = true; dirty = false; timedOut = false;
    const active = new AbortController(); controller = active;
    deadline = setTimeout(() => {
      timedOut = true; active.abort();
      if (live) options.publish({ phase: "error" });
    }, 30000);
    void Promise.resolve().then(() => options.load(active.signal)).then((value) => {
      if (live && !dirty && !timedOut) options.publish({ phase: "ready", data: value });
    }, () => {
      if (live && !dirty && !timedOut) options.publish({ phase: "error" });
    }).finally(() => {
      if (deadline !== undefined) clearTimeout(deadline);
      deadline = undefined; pending = false; controller = undefined;
      if (!live) return;
      if (dirty && !timedOut) refresh();
      else { dirty = false; schedule(); }
    });
  };
  const dispose = () => {
    live = false; clearTimer();
    if (deadline !== undefined) clearTimeout(deadline);
    controller?.abort();
  };
  return { refresh, dispose };
}

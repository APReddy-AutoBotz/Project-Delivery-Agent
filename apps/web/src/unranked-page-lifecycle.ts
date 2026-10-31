// The owner creates this before mounting a view and keeps it across scope,
// session and component changes. It contains no customer or evidence data.
export function createUnrankedPageLifecycle(doc: Document = document, win: Window = window) {
  let pageHidden = false, frozen = false, live = true;
  const listeners = new Set<(revalidate: boolean) => void>();
  const visible = () => live && !pageHidden && !frozen && doc.visibilityState === "visible";
  const emit = (revalidate: boolean) => { if (live) for (const listener of listeners) listener(revalidate); };
  const visibility = () => emit(false);
  const pageHide = () => { pageHidden = true; emit(false); };
  const pageShow = () => { pageHidden = false; emit(true); };
  const freeze = () => { frozen = true; emit(false); };
  const resume = () => { frozen = false; emit(true); };
  const focus = () => emit(true);
  doc.addEventListener("visibilitychange", visibility); doc.addEventListener("freeze", freeze); doc.addEventListener("resume", resume);
  win.addEventListener("pagehide", pageHide); win.addEventListener("pageshow", pageShow); win.addEventListener("focus", focus);
  return {
    visible,
    subscribe(listener: (revalidate: boolean) => void) { if (live) listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (!live) return;
      live = false;
      for (const listener of listeners) { try { listener(false); } catch { /* Continue clearing every subscriber. */ } }
      listeners.clear();
      doc.removeEventListener("visibilitychange", visibility); doc.removeEventListener("freeze", freeze); doc.removeEventListener("resume", resume);
      win.removeEventListener("pagehide", pageHide); win.removeEventListener("pageshow", pageShow); win.removeEventListener("focus", focus);
    },
  };
}

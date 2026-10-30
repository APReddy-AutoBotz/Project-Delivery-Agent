import React, { useEffect, useRef, useState } from "react";
import { Button, Message } from "./components.js";
import { loadReassessmentPreview, type ReassessmentPreview } from "./ingestion-reassessment-preview.js";

type Request = (path: string, init: RequestInit, onUnavailable: (denied?: boolean) => void) => Promise<unknown>;
type View = { phase: "idle" | "loading" | "error" } | { phase: "ready"; data: ReassessmentPreview };
const lifetime = 30000;
export function IngestionReassessmentPreview({ projectId, request }: { projectId: string; request: Request }) {
  const [view, setView] = useState<View>({ phase: "idle" });
  const turn = useRef(0), alive = useRef(true), controller = useRef<AbortController | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef<{ wall: number; monotonic: number } | null>(null);
  const cancel = () => {
    turn.current++; controller.current?.abort(); controller.current = null; started.current = null;
    if (deadline.current !== undefined) clearTimeout(deadline.current);
    if (expiry.current !== undefined) clearTimeout(expiry.current);
    deadline.current = undefined; expiry.current = undefined;
  };
  const expired = () => {
    if (!started.current) return true;
    const wall = Date.now() - started.current.wall, monotonic = performance.now() - started.current.monotonic;
    return wall < 0 || monotonic < 0 || wall >= lifetime || monotonic >= lifetime;
  };
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { cancel(); setView({ phase: "idle" }); };
    window.addEventListener("focus", invalidate); document.addEventListener("visibilitychange", invalidate);
    return () => { alive.current = false; cancel(); window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", invalidate); };
  }, []);
  const shown: View = view.phase === "ready" && expired() ? { phase: "idle" } : view;
  useEffect(() => {
    if (view.phase === "ready" && expired()) { cancel(); setView({ phase: "idle" }); }
  });
  async function load() {
    if (view.phase === "loading" || document.visibilityState !== "visible") return;
    cancel(); const current = ++turn.current, requestController = new AbortController(); controller.current = requestController;
    started.current = { wall: Date.now(), monotonic: performance.now() }; setView({ phase: "loading" });
    deadline.current = setTimeout(() => {
      if (alive.current && turn.current === current) { requestController.abort(); setView({ phase: "error" }); }
    }, 15000);
    expiry.current = setTimeout(() => {
      if (alive.current && turn.current === current) { cancel(); setView({ phase: "idle" }); }
    }, lifetime);
    try {
      const data = await loadReassessmentPreview(projectId, request, requestController.signal, () => {
        if (alive.current && turn.current === current && !requestController.signal.aborted) setView({ phase: "error" });
      });
      if (alive.current && turn.current === current && !requestController.signal.aborted) {
        if (expired()) { cancel(); setView({ phase: "idle" }); }
        else setView({ phase: "ready", data });
      }
    } catch {
      if (alive.current && turn.current === current && !requestController.signal.aborted) setView({ phase: "error" });
    } finally {
      if (controller.current === requestController) { controller.current = null;
        if (deadline.current !== undefined) clearTimeout(deadline.current); deadline.current = undefined; }
    }
  }
  return <section className="panel space-y-3" aria-labelledby="ingestion-reassessment-preview-heading">
    <h2 id="ingestion-reassessment-preview-heading">Ingestion reassessment status</h2>
    <p className="muted">The first page contains work visible to your account at the time of the read. It is ordered by identifier,
      not time, and is not a complete or continuously authorized view. A completed reassessment does not confirm publication or approval.</p>
    <Button className="secondary" disabled={shown.phase === "loading"} onClick={() => void load()}>Load reassessment status</Button>
    {shown.phase === "idle" && <p>Load this page to check current access.</p>}
    {shown.phase === "loading" && <p role="status">Checking current access…</p>}
    {shown.phase === "error" && <Message error>Reassessment status is unavailable. Retry after the previous read has finished.</Message>}
    {shown.phase === "ready" && <>
      {shown.data.rows.length === 0 ? <p>No reassessment work was visible to your account on this page.</p> :
        <ul>{shown.data.rows.map((row, index) => <li key={index}>
          <strong>{row.state}</strong> · {row.reason.replaceAll("_", " ")} · attempts {row.attemptCount} in this cycle, {row.totalAttempts} total.
          <br />Recorded {row.createdAt}; scheduled availability {row.availableAt}{row.completedAt ? `; completed ${row.completedAt}` : ""}.
        </li>)}</ul>}
      {shown.data.more && <p className="muted">More work was indicated by this read; it is not shown here.</p>}
    </>}
  </section>;
}

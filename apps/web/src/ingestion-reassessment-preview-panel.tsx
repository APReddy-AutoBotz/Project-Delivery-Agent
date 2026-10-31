import React, { useEffect, useRef, useState } from "react";
import { Button, Message } from "./components.js";
import { loadReassessmentPreview, type ReassessmentPreview } from "./ingestion-reassessment-preview.js";

type Request = (path: string, init: RequestInit, onUnavailable: (denied?: boolean) => void) => Promise<unknown>;
type View = { phase: "idle" | "loading" | "error" } | { phase: "ready"; data: ReassessmentPreview };
const lifetime = 30000;
export function IngestionReassessmentPreview({ projectId, request, invalidateRef, isCurrentScope }: {
  projectId: string; request: Request; invalidateRef: React.RefObject<(() => void) | null>; isCurrentScope: () => boolean;
}) {
  const [view, setView] = useState<View>({ phase: "idle" });
  const turn = useRef(0), alive = useRef(true), controller = useRef<AbortController | null>(null);
  const action = useRef(false), valid = useRef(false), renderedTurn = turn.current;
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef<{ wall: number; monotonic: number } | null>(null);
  const cancel = () => {
    turn.current++; valid.current = false; action.current = false; controller.current?.abort(); controller.current = null; started.current = null;
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
    invalidateRef.current = invalidate;
    setView({ phase: "idle" });
    window.addEventListener("focus", invalidate); document.addEventListener("visibilitychange", invalidate);
    return () => { alive.current = false; cancel(); if (invalidateRef.current === invalidate) invalidateRef.current = null;
      window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", invalidate); };
  }, []);
  const shown: View = view.phase === "ready" && expired() ? { phase: "idle" } : view;
  useEffect(() => {
    if (view.phase === "ready" && expired()) { cancel(); setView({ phase: "idle" }); }
  });
  async function load(after?: string) {
    if (!isCurrentScope() || turn.current !== renderedTurn || action.current || view.phase === "loading" || document.visibilityState !== "visible") return;
    if (view.phase === "ready" && expired()) { cancel(); setView({ phase: "idle" }); return; }
    if (after && (view.phase !== "ready" || !valid.current || view.data.next !== after)) return;
    cancel(); action.current = true; const current = ++turn.current, requestController = new AbortController(); controller.current = requestController;
    started.current = { wall: Date.now(), monotonic: performance.now() }; setView({ phase: "loading" });
    deadline.current = setTimeout(() => {
      if (isCurrentScope() && alive.current && turn.current === current) { cancel(); setView({ phase: "error" }); }
    }, 15000);
    expiry.current = setTimeout(() => {
      if (isCurrentScope() && alive.current && turn.current === current) { cancel(); setView({ phase: "idle" }); }
    }, lifetime);
    try {
      const data = await loadReassessmentPreview(projectId, request, requestController.signal, () => {
        // Withhold immediately but let the denial body drain. The deadline and
        // shared lease remain active until settlement or timeout.
        if (isCurrentScope() && alive.current && turn.current === current && !requestController.signal.aborted) {
          valid.current = false; setView({ phase: "error" });
        }
      }, after);
      if (isCurrentScope() && alive.current && turn.current === current && !requestController.signal.aborted) {
        if (expired()) { cancel(); setView({ phase: "idle" }); }
        else { valid.current = true; setView({ phase: "ready", data }); }
      }
    } catch {
      if (isCurrentScope() && alive.current && turn.current === current && !requestController.signal.aborted) { valid.current = false; setView({ phase: "error" }); }
    } finally {
      if (controller.current === requestController) { controller.current = null; action.current = false;
        if (deadline.current !== undefined) clearTimeout(deadline.current); deadline.current = undefined; }
    }
  }
  return <section className="panel space-y-3" aria-labelledby="ingestion-reassessment-preview-heading">
    <h2 id="ingestion-reassessment-preview-heading">Ingestion reassessment status</h2>
    <p className="muted">Each page contains work visible to your account at the time of that read. Pages are ordered by identifier,
      not time, and are not a snapshot; newly inserted work before the current position may be missed. Access can change.
      A completed reassessment does not confirm publication or approval.</p>
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
      {shown.data.advanced && <Button className="secondary" onClick={() => void load()}>First page</Button>}
      {shown.data.more && shown.data.next && <><p className="muted">More work was indicated by this read.</p>
        <Button className="secondary" onClick={() => void load(shown.data.next)}>Next page</Button></>}
    </>}
  </section>;
}

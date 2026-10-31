import React, { useEffect, useRef, useState } from "react";
import { Button, Message } from "./components.js";
import { loadReconciliationPreview, loadReconciliationPreviewPage, type PreviewItem, type PreviewKind, type PreviewPart, type PreviewProject, type PreviewRow } from "./pm-reconciliation-preview.js";

type Request = (path: string, init: RequestInit, onUnavailable: (denied?: boolean) => void) => Promise<unknown>;
type View = { phase: "idle" } | { phase: "loading" | "ready"; rows: PreviewRow[] } | { phase: "error" };

export function PmReconciliationPreview({ projects, subject, request, openRequest, invalidateRef, isCurrentSession }: {
  projects: PreviewProject[]; subject: string; request: Request;
  openRequest: (projectId: string, kind: PreviewKind, requestId: string) => void;
  invalidateRef: React.RefObject<(() => void) | null>;
  isCurrentSession: () => boolean;
}) {
  const [offset, setOffset] = useState(0), [view, setView] = useState<View>({ phase: "idle" });
  const turn = useRef(0), controller = useRef<AbortController | null>(null), alive = useRef(true);
  const action = useRef(false), valid = useRef(false);
  const renderedTurn = turn.current;
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => { turn.current++; valid.current = false; controller.current?.abort(); controller.current = null; action.current = false;
    if (deadline.current !== undefined) clearTimeout(deadline.current); deadline.current = undefined; };
  useEffect(() => {
    alive.current = true;
    // A development StrictMode setup/cleanup replay advances the turn; render
    // again so handlers belong to the current turn before accepting actions.
    setView({ phase: "idle" });
    const invalidate = () => { cancel(); setView({ phase: "idle" }); };
    invalidateRef.current = invalidate;
    window.addEventListener("focus", invalidate); document.addEventListener("visibilitychange", invalidate);
    return () => { alive.current = false; cancel(); if (invalidateRef.current === invalidate) invalidateRef.current = null;
      window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", invalidate); };
  }, []);
  const batch = projects.slice(offset, offset + 5);
  async function load() {
    if (!isCurrentSession() || turn.current !== renderedTurn || action.current || view.phase === "loading" || !batch.length || document.visibilityState !== "visible") return;
    cancel(); action.current = true; const current = ++turn.current, active = new AbortController(); controller.current = active;
    setView({ phase: "loading", rows: [] });
    deadline.current = setTimeout(() => {
      if (isCurrentSession() && alive.current && turn.current === current) { active.abort(); setView({ phase: "error" }); }
    }, 15000);
    try {
      const rows = await loadReconciliationPreview(batch, subject, request, active.signal, (partial) => {
        if (isCurrentSession() && alive.current && turn.current === current && !active.signal.aborted) setView({ phase: "loading", rows: partial });
      });
      if (isCurrentSession() && alive.current && turn.current === current && !active.signal.aborted) { valid.current = true; setView({ phase: "ready", rows }); }
    } catch {
      if (isCurrentSession() && alive.current && turn.current === current && !active.signal.aborted) setView({ phase: "error" });
    } finally { if (controller.current === active) { controller.current = null; action.current = false;
      if (deadline.current !== undefined) clearTimeout(deadline.current); deadline.current = undefined; } }
  }
  function changeBatch(next: number) { if (!isCurrentSession() || turn.current !== renderedTurn) return; cancel(); setView({ phase: "idle" }); setOffset(next); }
  function open(projectId: string, kind: PreviewKind, requestId: string) {
    if (!isCurrentSession() || !valid.current || turn.current !== renderedTurn) return;
    cancel(); openRequest(projectId, kind, requestId);
  }
  async function loadPage(projectId: string, kind: PreviewKind, after: PreviewItem | null) {
    if (!isCurrentSession() || !valid.current || turn.current !== renderedTurn || action.current || view.phase !== "ready" ||
        document.visibilityState !== "visible" || !view.rows.some((row) => row.project.projectId === projectId)) return;
    cancel(); action.current = true; const current = ++turn.current, active = new AbortController(); controller.current = active;
    let rows = view.rows.map((row): PreviewRow => row.project.projectId === projectId
      ? { ...row, milestone: kind === "milestone" ? { phase: "loading" } : { phase: "idle" },
          scalar: kind === "scalar" ? { phase: "loading" } : { phase: "idle" } } : row);
    const publish = (phase: "loading" | "ready") => {
      if (isCurrentSession() && alive.current && turn.current === current && !active.signal.aborted) {
        if (phase === "ready") valid.current = true;
        setView({ phase, rows: rows.map((row) => ({ ...row })) });
      }
    };
    const markUnavailable = (denied = false) => {
      rows = rows.map((row): PreviewRow => row.project.projectId !== projectId ? row : denied
        ? { ...row, milestone: { phase: "unavailable" }, scalar: { phase: "unavailable" } }
        : { ...row, [kind]: { phase: "unavailable" } });
      publish("loading");
    };
    publish("loading");
    deadline.current = setTimeout(() => {
      if (isCurrentSession() && alive.current && turn.current === current) { active.abort(); setView({ phase: "error" }); }
    }, 15000);
    try {
      const result = await loadReconciliationPreviewPage(projectId, subject, kind, after, request, active.signal, markUnavailable);
      if (!active.signal.aborted) rows = rows.map((row) => row.project.projectId === projectId ? { ...row, [kind]: result } : row);
      publish("ready");
    } catch {
      if (!active.signal.aborted) { markUnavailable(); publish("ready"); }
    } finally { if (controller.current === active) { controller.current = null; action.current = false;
      if (deadline.current !== undefined) clearTimeout(deadline.current); deadline.current = undefined; } }
  }
  return <section className="space-y-3" aria-labelledby="pm-reconciliation-preview-heading">
    <h3 id="pm-reconciliation-preview-heading">Recorded reconciliation requests</h3>
    <p className="muted">Preview up to 20 requests per page for each type and up to five assigned projects. Pages are separate live reads;
      assignments and access can change, and new requests before a cursor may be missed. An open request does not establish that a disagreement is still current.</p>
    {projects.length === 0 ? <p>No projects in the current assigned-project observation.</p> : <>
      <p>Project batch {Math.floor(offset / 5) + 1} of {Math.ceil(projects.length / 5)}</p>
      <div className="actions">
        {offset > 0 && <Button className="secondary" onClick={() => changeBatch(0)}>First project batch</Button>}
        {offset + 5 < projects.length && <Button className="secondary" onClick={() => changeBatch(offset + 5)}>Next project batch</Button>}
        <Button className="secondary" disabled={view.phase === "loading"} onClick={() => void load()}>Load reconciliation previews</Button>
      </div>
      {view.phase === "idle" && <p>Load this batch to check its recorded requests.</p>}
      {view.phase === "error" && <Message error>Previews are unavailable. Retry after the previous reads have finished.</Message>}
      {(view.phase === "loading" || view.phase === "ready") && <>
        {view.phase === "loading" && <p role="status">Checking request access for this batch…</p>}
        {view.rows.map((row) => <article key={row.project.projectId} className="rounded-lg border border-slate-200 p-4 space-y-2">
          <h4>{row.project.name}</h4>
          <PreviewCategory label="Milestone" part={row.milestone} disabled={view.phase === "loading"}
            load={(after) => void loadPage(row.project.projectId, "milestone", after)} open={(id) => open(row.project.projectId, "milestone", id)} />
          <PreviewCategory label="Scalar" part={row.scalar} disabled={view.phase === "loading"}
            load={(after) => void loadPage(row.project.projectId, "scalar", after)} open={(id) => open(row.project.projectId, "scalar", id)} />
        </article>)}
      </>}
    </>}
  </section>;
}

function PreviewCategory({ label, part, open, load, disabled }: { label: string; part: PreviewPart; open: (id: string) => void;
  load: (after: PreviewItem | null) => void; disabled: boolean }) {
  return <div>
    <h5>{label} reconciliation</h5>
    {part.phase === "idle" && <p>This category was cleared. <Button className="secondary" disabled={disabled} onClick={() => load(null)}>Check first page</Button></p>}
    {part.phase === "loading" && <p role="status">Checking access…</p>}
    {part.phase === "unavailable" && <p>Requests unavailable for this project and type.</p>}
    {part.phase === "ready" && <>
      {part.items.length === 0 ? <p>No recorded open requests on this page.</p> : <ul>{part.items.map((item) => <li key={item.id}>
        Recorded open request · {item.createdAt}{" "}<Button className="secondary" disabled={disabled} aria-label={`Open ${label.toLowerCase()} request recorded ${item.createdAt}`}
          onClick={() => open(item.id)}>Open request</Button>
      </li>)}</ul>}
      {part.advanced && <Button className="secondary" disabled={disabled} onClick={() => load(null)}>Check first page</Button>}
      {part.more && part.next && <><p className="muted">More may exist in the project.</p>
        <Button className="secondary" disabled={disabled} onClick={() => load(part.next!)}>Next page</Button></>}
    </>}
  </div>;
}

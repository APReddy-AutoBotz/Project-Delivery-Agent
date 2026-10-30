import React, { useEffect, useRef, useState } from "react";
import { Button, Message } from "./components.js";
import { loadReconciliationPreview, type PreviewKind, type PreviewPart, type PreviewProject, type PreviewRow } from "./pm-reconciliation-preview.js";

type Request = (path: string, init: RequestInit, onUnavailable: (denied?: boolean) => void) => Promise<unknown>;
type View = { phase: "idle" } | { phase: "loading" | "ready"; rows: PreviewRow[] } | { phase: "error" };

export function PmReconciliationPreview({ projects, subject, request, openRequest }: {
  projects: PreviewProject[]; subject: string; request: Request;
  openRequest: (projectId: string, kind: PreviewKind, requestId: string) => void;
}) {
  const [offset, setOffset] = useState(0), [view, setView] = useState<View>({ phase: "idle" });
  const turn = useRef(0), controller = useRef<AbortController | null>(null), alive = useRef(true);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => { turn.current++; controller.current?.abort(); controller.current = null;
    if (deadline.current !== undefined) clearTimeout(deadline.current); deadline.current = undefined; };
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { cancel(); setView({ phase: "idle" }); };
    window.addEventListener("focus", invalidate); document.addEventListener("visibilitychange", invalidate);
    return () => { alive.current = false; cancel(); window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", invalidate); };
  }, []);
  const batch = projects.slice(offset, offset + 5);
  async function load() {
    if (view.phase === "loading" || !batch.length || document.visibilityState !== "visible") return;
    cancel(); const current = ++turn.current, active = new AbortController(); controller.current = active;
    setView({ phase: "loading", rows: [] });
    deadline.current = setTimeout(() => {
      if (alive.current && turn.current === current) { active.abort(); setView({ phase: "error" }); }
    }, 15000);
    try {
      const rows = await loadReconciliationPreview(batch, subject, request, active.signal, (partial) => {
        if (alive.current && turn.current === current && !active.signal.aborted) setView({ phase: "loading", rows: partial });
      });
      if (alive.current && turn.current === current && !active.signal.aborted) setView({ phase: "ready", rows });
    } catch {
      if (alive.current && turn.current === current && !active.signal.aborted) setView({ phase: "error" });
    } finally { if (controller.current === active) { controller.current = null;
      if (deadline.current !== undefined) clearTimeout(deadline.current); deadline.current = undefined; } }
  }
  function changeBatch(next: number) { cancel(); setView({ phase: "idle" }); setOffset(next); }
  function open(projectId: string, kind: PreviewKind, requestId: string) { cancel(); openRequest(projectId, kind, requestId); }
  return <section className="space-y-3" aria-labelledby="pm-reconciliation-preview-heading">
    <h3 id="pm-reconciliation-preview-heading">Recorded reconciliation requests</h3>
    <p className="muted">Preview the first 20 requests of each type for up to five assigned projects. These are separate live reads;
      an open request does not establish that a disagreement is still current. Other project batches are not included.</p>
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
          <PreviewCategory label="Milestone" part={row.milestone} open={(id) => open(row.project.projectId, "milestone", id)} />
          <PreviewCategory label="Scalar" part={row.scalar} open={(id) => open(row.project.projectId, "scalar", id)} />
        </article>)}
      </>}
    </>}
  </section>;
}

function PreviewCategory({ label, part, open }: { label: string; part: PreviewPart; open: (id: string) => void }) {
  return <div>
    <h5>{label} reconciliation</h5>
    {part.phase === "loading" && <p role="status">Checking access…</p>}
    {part.phase === "unavailable" && <p>Requests unavailable for this project and type.</p>}
    {part.phase === "ready" && <>
      {part.items.length === 0 ? <p>No recorded open requests on this page.</p> : <ul>{part.items.map((item) => <li key={item.id}>
        Recorded open request · {item.createdAt}{" "}<Button className="secondary" aria-label={`Open ${label.toLowerCase()} request recorded ${item.createdAt}`}
          onClick={() => open(item.id)}>Open request</Button>
      </li>)}</ul>}
      {part.more && <p className="muted">First 20 shown; more may exist in the project.</p>}
    </>}
  </div>;
}

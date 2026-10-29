import React, { useEffect, useRef, useState } from "react";
import type { MilestoneConflictObservation } from "@pdaa/domain";
import { decodeMilestoneConflict } from "./milestone-conflict-decoder.js";
import { milestoneQuestionExample, supportsMilestoneQuestion } from "./milestone-question.js";
type RequestFn = <T>(path: string, init?: RequestInit) => Promise<T>;
import { Button, Message } from "./components.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";

type Item = { id: string; key: string; name?: string; title?: string };
export function LeadershipMilestoneConflict({ projectId, scope, milestones, workItems, request }: {
  projectId: string; scope: string; milestones: Item[]; workItems: Item[]; request: RequestFn;
}) {
  const [selected, setSelected] = useState("");
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<number | null>(null);
  const generation = useRef(0);
  const selectedItem = milestones.find((item) => item.id === selected);
  function invalidate() { generation.current++; setSubmitted(null); }
  function changeQuestion(value: string) {
    invalidate();
    if (value.length > 200) { setQuestion(""); setError("The question must be 200 characters or fewer."); return; }
    setQuestion(value); setError("");
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); invalidate();
    if (!selectedItem || !supportsMilestoneQuestion(question)) {
      setError("Select a milestone and use one of the supported questions shown below."); return;
    }
    setError(""); setSubmitted(generation.current);
  }
  return <section className="canonical-section" aria-labelledby="milestone-conflict-heading">
    <h3 id="milestone-conflict-heading">Ask about milestone completion</h3>
    <p className="muted">This check compares a milestone recorded complete with required work still open or in progress. It cannot establish completion.</p>
    <label htmlFor="milestone-conflict-select">Milestone</label>{" "}
    <select id="milestone-conflict-select" value={selectedItem?.id ?? ""} onChange={(event) => {
      invalidate(); setSelected(event.target.value); setQuestion(""); setError("");
    }}>
      <option value="">Select a milestone</option>
      {milestones.map((item) => <option key={item.id} value={item.id}>{item.key} · {item.name}</option>)}
    </select>
    <form onSubmit={submit} autoComplete="off">
      <label htmlFor="milestone-conflict-question">Question</label>{" "}
      <textarea id="milestone-conflict-question" value={question} autoComplete="off" spellCheck={false}
        aria-describedby="milestone-conflict-example" onChange={(event) => changeQuestion(event.target.value)} />
      <p className="muted" id="milestone-conflict-example">Supported question: {milestoneQuestionExample} Maximum 200 characters.</p>
      <Button type="submit" className="secondary">Check question</Button>
    </form>
    {error && <Message error>{error}</Message>}
    {selectedItem && submitted !== null && <Observation key={`${scope}:${selectedItem.id}:${submitted}`} projectId={projectId} milestoneId={selectedItem.id}
      scope={`${scope}:${selectedItem.id}:${submitted}`} milestones={milestones} workItems={workItems} request={request} />}
  </section>;
}
function Observation({ projectId, milestoneId, scope, milestones, workItems, request }: {
  projectId: string; milestoneId: string; scope: string; milestones: Item[]; workItems: Item[]; request: RequestFn;
}) {
  const loader = useRef(request), resource = useRef<ReturnType<typeof createPmQueueResource<MilestoneConflictObservation>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<MilestoneConflictObservation> }>({ scope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    const driver = createPmQueueResource<MilestoneConflictObservation>({
      load: async (signal) => {
        return decodeMilestoneConflict(await loader.current<unknown>(
          `/projects/${projectId}/milestones/${milestoneId}/leadership-conflict-observation`, { signal }), projectId, milestoneId);
      }, publish: (value) => setState({ scope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [scope, projectId, milestoneId]);
  const current = state.scope === scope ? state.value : { phase: "loading" as const };
  return <div className="space-y-3">
    <Button className="secondary" onClick={() => resource.current?.refresh()}>Refresh completion check</Button>
    <div aria-live="polite" aria-atomic="true">
    {current.phase === "loading" && <p role="status">Checking current evidence and access…</p>}
    {current.phase === "error" && <Message error>Completion check is unavailable. Refresh to check current access and evidence.</Message>}
    {current.phase === "ready" && current.data.outcome === "NOT_DETECTED" &&
      <p>This completion rule found no contradiction for the selected milestone at {current.data.asOf}. This does not assess other project conflicts.</p>}
    {current.phase === "ready" && current.data.outcome === "CONFLICTING" && <>
      <p>The milestone is recorded complete while required work remains open. Completion is not established; the project manager should reconcile the positions.</p>
      <p className="muted">Checked at {current.data.asOf}. This result does not create a reconciliation request.</p>
      <p className="muted">Provenance labels are stored with the evidence; this check does not independently verify a source or a person's confirmation.</p>
      {current.data.positions.map((position) => {
        const target = (position.targetKind === "MILESTONE" ? milestones : workItems).find((item) => item.id === position.targetId);
        return <div className="canonical-review-row" key={position.bindingId}>
          <p><strong>{target?.key ?? "Authorized item"}</strong> · {position.targetKind === "MILESTONE" ? "Milestone" : "Required work item"} · {position.state.replaceAll("_", " ")}</p>
          <p className="muted">Policy revision: {position.policyRevisionId}</p>
          <ul>{position.supports.map((support) => <li key={support.versionId}>
            Evidence {support.evidenceId} · version {support.versionId} · source {support.sourceId} · stored provenance: {support.provenance.replaceAll("_", " ")} · observed {support.observedAt} · valid until {support.assessedValidUntil}
          </li>)}</ul>
        </div>;
      })}
    </>}
    </div>
  </div>;
}

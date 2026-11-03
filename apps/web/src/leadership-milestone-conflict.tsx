import React, { useEffect, useRef, useState } from "react";
import type { MilestoneConflictObservation, MilestoneStateDisagreement } from "@pdaa/domain";
import { decodeMilestoneConflict, decodeMilestoneRequestObservation } from "./milestone-conflict-decoder.js";
import { decodeMilestoneStateDisagreement } from "./milestone-state-disagreement-decoder.js";
import type { RequestFn } from "./request-types.js";
import { milestoneQuestionExample, supportsMilestoneQuestion } from "./milestone-question.js";
import { Button, Message } from "./components.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";

type Item = { id: string; key: string; name?: string; title?: string };
export function LeadershipMilestoneConflict({ projectId, scope, milestones, workItems, request, selected, question, onDraftChange, canInspectRequest = false }: {
  projectId: string; scope: string; milestones: Item[]; workItems: Item[]; request: RequestFn; canInspectRequest?: boolean;
  selected: string; question: string; onDraftChange: (value: { selected: string; question: string }) => void;
}) {
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<number | null>(null);
  const generation = useRef(0);
  const selectedItem = milestones.find((item) => item.id === selected);
  function invalidate() { generation.current++; setSubmitted(null); }
  function changeQuestion(value: string) {
    invalidate();
    if (value.length > 200) { onDraftChange({ selected, question: "" }); setError("The question must be 200 characters or fewer."); return; }
    onDraftChange({ selected, question: value }); setError("");
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
      invalidate(); onDraftChange({ selected: event.target.value, question: "" }); setError("");
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
    {selectedItem && <StateDisagreement key={`${scope}:${selectedItem.id}`} projectId={projectId} milestoneId={selectedItem.id}
      scope={`${scope}:${selectedItem.id}`} request={request} />}
    {selectedItem && submitted !== null && <Observation key={`${scope}:${selectedItem.id}:${submitted}`} projectId={projectId} milestoneId={selectedItem.id}
      scope={`${scope}:${selectedItem.id}:${submitted}`} milestones={milestones} workItems={workItems} request={request} canInspectRequest={canInspectRequest} />}
  </section>;
}
function StateDisagreement({ projectId, milestoneId, scope, request }: {
  projectId: string; milestoneId: string; scope: string; request: RequestFn;
}) {
  type TimedResult = { observation: MilestoneStateDisagreement; expiresAt: number };
  const [requested, setRequested] = useState(false);
  const loader = useRef(request), resource = useRef<ReturnType<typeof createPmQueueResource<TimedResult>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<TimedResult> }>({ scope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    if (!requested) return;
    let live = true;
    const driver = createPmQueueResource<TimedResult>({
      load: async (signal) => {
        const started = performance.now();
        const observation = decodeMilestoneStateDisagreement(await loader.current<unknown>(
          `/projects/${projectId}/milestones/${milestoneId}/leadership-state-disagreement`, { signal }, 262144,
          () => { if (live && !signal.aborted) setState({ scope, value: { phase: "error" } }); }), projectId, milestoneId);
        const deadline = Math.min(...observation.positions.flatMap((position) => position.supports.map((support) => Date.parse(support.assessedValidUntil))));
        // The server evaluates at asOf after this request starts; measuring from
        // the client start is conservative about transit and processing delay.
        const expiresAt = started + deadline - Date.parse(observation.asOf);
        if (!Number.isFinite(expiresAt) || expiresAt <= performance.now()) throw new Error("Disagreement expired");
        return { observation, expiresAt };
      },
      publish: (value) => setState({ scope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { live = false; driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [requested, scope, projectId, milestoneId]);
  useEffect(() => {
    if (!requested || state.scope !== scope || state.value.phase !== "ready") return;
    const remaining = state.value.data.expiresAt - performance.now();
    const timer = setTimeout(() => resource.current?.refresh(), Math.max(0, Math.min(remaining, 2147483647)));
    return () => clearTimeout(timer);
  }, [requested, scope, state]);
  const current = state.scope === scope ? state.value : { phase: "loading" as const };
  const display = current.phase === "ready" && current.data.expiresAt <= performance.now() ? { phase: "loading" as const } : current;
  return <div className="space-y-3">
    <Button className="secondary" onClick={() => { if (requested) resource.current?.refresh(); else setRequested(true); }}>
      {requested ? "Refresh milestone state evidence" : "Check for conflicting milestone states"}
    </Button>
    {requested && <div aria-live="polite" aria-atomic="true">
      {display.phase === "loading" && <p role="status">Checking current milestone state evidence…</p>}
      {display.phase === "error" && <Message error>Current conflicting state evidence could not be established. Refresh to check access and evidence.</Message>}
      {display.phase === "ready" && <>
        <p>Records with stored human-confirmed provenance disagree about this milestone’s state. No state has been selected as the winner.</p>
        <p className="muted">Checked at {display.data.observation.asOf}. This check does not create a reconciliation request or independently verify a person’s confirmation.</p>
        {display.data.observation.positions.map((position) => <div className="canonical-review-row" key={position.state}>
          <p><strong>{position.state.replaceAll("_", " ")}</strong></p>
          <ul>{position.supports.map((support) => <li key={support.versionId}>
            Evidence {support.evidenceId} · version {support.versionId} · source {support.sourceId} · observed {support.observedAt} · valid until {support.assessedValidUntil}
          </li>)}</ul>
        </div>)}
      </>}
    </div>}
  </div>;
}
type View = { observation: MilestoneConflictObservation; requestStatus: "MATCHING_REQUEST_RECORDED" | "NO_MATCHING_REQUEST_RECORDED" | null; expiresAt: number | null };
function Observation({ projectId, milestoneId, scope, milestones, workItems, request, canInspectRequest }: {
  projectId: string; milestoneId: string; scope: string; milestones: Item[]; workItems: Item[]; request: RequestFn; canInspectRequest: boolean;
}) {
  const [showRequest, setShowRequest] = useState(false);
  const mode = canInspectRequest && showRequest ? "request" : "conflict", viewScope = `${scope}:${mode}`;
  const loader = useRef(request), resource = useRef<ReturnType<typeof createPmQueueResource<View>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<View> }>({ scope: viewScope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    let live = true;
    const driver = createPmQueueResource<View>({
      load: async (signal) => {
        const started = performance.now();
        const path = `/projects/${projectId}/milestones/${milestoneId}/`;
        const unavailable = () => { if (live && !signal.aborted) setState({ scope: viewScope, value: { phase: "error" } }); };
        const result = mode === "request" ? decodeMilestoneRequestObservation(await loader.current<unknown>(
          path + "leadership-manager-request-observation", { signal }, 262144, unavailable), projectId, milestoneId)
          : { observation: decodeMilestoneConflict(await loader.current<unknown>(
            path + "leadership-conflict-observation", { signal }, 262144, unavailable), projectId, milestoneId), requestStatus: null };
        if (result.observation.outcome === "NOT_DETECTED") return { ...result, expiresAt: null };
        const deadline = Math.min(...result.observation.positions.flatMap((position) => position.supports.map((support) => Date.parse(support.assessedValidUntil))));
        // The server's as-of is no earlier than request start. Subtract the
        // full client-observed transit and processing interval conservatively.
        const expiresAt = started + deadline - Date.parse(result.observation.asOf);
        if (!Number.isFinite(expiresAt) || expiresAt <= performance.now()) throw new Error("Observation expired");
        return { ...result, expiresAt };
      }, publish: (value) => setState({ scope: viewScope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { live = false; driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [viewScope, mode, projectId, milestoneId]);
  useEffect(() => {
    if (state.scope !== viewScope || state.value.phase !== "ready" || state.value.data.expiresAt === null) return;
    const remaining = state.value.data.expiresAt - performance.now();
    const timer = setTimeout(() => resource.current?.refresh(), Math.max(0, Math.min(remaining, 2147483647)));
    return () => clearTimeout(timer);
  }, [viewScope, state]);
  const current = state.scope === viewScope ? state.value : { phase: "loading" as const };
  const display = current.phase === "ready" && current.data.expiresAt !== null && current.data.expiresAt <= performance.now()
    ? { phase: "loading" as const } : current;
  return <div className="space-y-3">
    {canInspectRequest && <Button className="secondary" onClick={() => setShowRequest((value) => !value)}>
      {mode === "request" ? "Show completion check only" : "Check for a recorded request"}
    </Button>}
    <Button className="secondary" onClick={() => resource.current?.refresh()}>Refresh completion check</Button>
    <div aria-live="polite" aria-atomic="true">
    {display.phase === "loading" && <p role="status">Checking current evidence and access…</p>}
    {display.phase === "error" && <Message error>Completion check is unavailable. Refresh to check current access and evidence.</Message>}
    {display.phase === "ready" && display.data.observation.outcome === "NOT_DETECTED" &&
      <p>This completion rule found no contradiction for the selected milestone at {display.data.observation.asOf}. This does not assess other project conflicts. Evidence may have changed; refresh before relying on this check.</p>}
    {display.phase === "ready" && display.data.observation.outcome === "CONFLICTING" && <>
      <p>At this check, the milestone was recorded complete while required work was open. Completion is not established; the project manager should reconcile the positions.</p>
      <p className="muted">Checked at {display.data.observation.asOf}. Evidence and request status may have changed; refresh before relying on this check. This result does not create a reconciliation request.</p>
      {mode === "request" && display.data.requestStatus === "MATCHING_REQUEST_RECORDED" &&
        <p>At this check, a request was recorded for these contributing positions. This does not confirm a current assignment or delivery.</p>}
      {mode === "request" && display.data.requestStatus === "NO_MATCHING_REQUEST_RECORDED" &&
        <p>At this check, no request was recorded for these contributing positions. An older request may exist.</p>}
      <p className="muted">Provenance labels are stored with the evidence; this check does not independently verify a source or a person's confirmation.</p>
      {display.data.observation.positions.map((position) => {
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

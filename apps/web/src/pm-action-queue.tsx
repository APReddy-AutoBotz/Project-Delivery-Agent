import React, { useEffect, useRef, useState } from "react";
import type { PmActionQueue } from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, Message } from "./components.js";
import { FactList, SignalEvidence } from "./delivery-suggestions.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";
import { decodePmQueue } from "./pm-queue-decoder.js";
import { BlockerAgeObservation } from "./blocker-age-observation.js";
import { PmReconciliationPreview } from "./pm-reconciliation-preview-panel.js";
import type { PreviewKind } from "./pm-reconciliation-preview.js";
import { ManagedReadRegistry } from "./managed-read-registry.js";
import { managedRead, ManagedReadCapacityError } from "./managed-read.js";
import { createPreviewRequestFactory } from "./pm-preview-request.js";

// Physical queue originals outlive a panel, including across identity changes.
// An unknown local cleanup conservatively keeps the page's slot occupied.
const queueReads = new ManagedReadRegistry(1);
const previewReads = new ManagedReadRegistry(2);

// EXEC-026: a bounded observation of assigned projects, not a complete queue.
export function PmActionQueuePanel({ scope, subject, request, openProject, openRequest, previewInvalidate, isCurrentPreviewSession }: {
  scope: string; subject: string; request: RequestFn;
  openProject: (projectId: string) => void; openRequest: (projectId: string, kind: PreviewKind, requestId: string) => void;
  previewInvalidate: React.RefObject<(() => void) | null>; isCurrentPreviewSession: () => boolean;
}) {
  const queueEpoch = useRef(0);
  const resource = useRef<ReturnType<typeof createPmQueueResource<PmActionQueue>> | null>(null);
  const refreshAction = useRef<(() => void) | null>(null);
  const currentProof = useRef<object | null>(null);
  const issuedPreviewSignals = useRef(new WeakSet<AbortSignal>());
  const publicationGeneration = useRef(0);
  const [state, setState] = useState<{ scope: string; epoch: number; proof: object | null; value: PmQueueResourceState<PmActionQueue> }>({ scope, epoch: 0, proof: null, value: { phase: "loading" } });
  useEffect(() => {
    let live = true, wanted = false, wakeScheduled = false;
    const wake = () => {
      if (wakeScheduled) return;
      wakeScheduled = true;
      queueMicrotask(() => {
        wakeScheduled = false;
        if (!live || resource.current !== driver || !isCurrentPreviewSession() || !wanted ||
            queueReads.full() || driver.pending()) return;
        wanted = false; driver.refresh();
      });
    };
    const driver: ReturnType<typeof createPmQueueResource<PmActionQueue>> = createPmQueueResource<PmActionQueue>({
      load: async (signal) => {
        try {
          const value = await managedRead(queueReads, signal,
            () => isCurrentPreviewSession() && driver.current(signal),
            (current, completion) => request<unknown>("/pm/action-queue", { redirect: "error" }, 2 * 1024 * 1024,
              () => driver.unavailable(signal), { current, completion }, current, 200));
          return decodePmQueue(value);
        } catch (error) {
          if (error instanceof ManagedReadCapacityError && driver.current(signal) && isCurrentPreviewSession()) {
            wanted = true; wake();
          }
          throw error;
        }
      },
      publish: (value) => {
        if (!live || resource.current !== driver || !isCurrentPreviewSession()) return;
        const publication = ++publicationGeneration.current;
        currentProof.current = null;
        if (value.phase !== "ready") { queueEpoch.current++; previewInvalidate.current?.(); }
        if (!live || resource.current !== driver || !isCurrentPreviewSession() || publicationGeneration.current !== publication) return;
        const proof = Object.freeze({}); currentProof.current = proof;
        setState({ scope, epoch: queueEpoch.current, proof, value });
      },
      visible: () => document.visibilityState === "visible",
      settled: wake,
    });
    resource.current = driver;
    const unsubscribe = queueReads.subscribe(wake);
    const refresh = () => {
      if (!live || resource.current !== driver || !isCurrentPreviewSession()) return;
      if (driver.pending() && driver.timedOut()) { wanted = true; wake(); }
      else wanted = false;
      driver.refresh();
    };
    refreshAction.current = refresh;
    driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { live = false; wanted = false; unsubscribe(); if (resource.current === driver) { resource.current = null; currentProof.current = null; publicationGeneration.current++; } driver.dispose();
      if (refreshAction.current === refresh) refreshAction.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [scope, request, previewInvalidate, isCurrentPreviewSession]);
  const isCurrentPublication = React.useCallback(() => Boolean(isCurrentPreviewSession() && state.scope === scope &&
    state.proof && currentProof.current === state.proof), [isCurrentPreviewSession, scope, state.scope, state.proof]);
  const current = isCurrentPreviewSession() && state.scope === scope && state.proof === currentProof.current ? state.value : { phase: "loading" as const };
  const renderedRefresh = refreshAction.current;
  const queue = current.phase === "ready" ? current.data : undefined;
  const projects = new Map(queue?.projects.map((project) => [project.projectId, project]) ?? []);
  const isCurrentQueue = React.useCallback(() => Boolean(isCurrentPublication() && state.value.phase === "ready"),
    [isCurrentPublication, state.value.phase]);
  const requestFactory = React.useMemo(() => createPreviewRequestFactory({ queueCurrent: isCurrentQueue,
    projectIds: state.value.phase === "ready" ? state.value.data.projects.map((project) => project.projectId) : [],
    request, registry: previewReads, issuedSignals: issuedPreviewSignals.current }), [isCurrentQueue, request, state.value]);
  const openQueueProject = (projectId: string) => { if (isCurrentQueue() && projects.has(projectId)) openProject(projectId); };
  const openQueueRequest = (projectId: string, kind: PreviewKind, requestId: string) => {
    if (isCurrentQueue() && projects.has(projectId)) openRequest(projectId, kind, requestId);
  };
  return <section className="panel space-y-4" aria-labelledby="pm-action-queue-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <span className="eyebrow">ASSIGNED PROJECTS</span>
        <h2 id="pm-action-queue-heading">Action suggestions</h2>
        <p className="muted">Schedule, update information and source-authorized blocker-age review. Approvals and other categories are unavailable.
          Schedule suggestions do not assess source authority. Each observation has its own evaluation time; access and data can change.</p>
      </div>
      <Button className="secondary" onClick={() => {
        if (renderedRefresh && refreshAction.current === renderedRefresh && isCurrentPublication()) renderedRefresh();
      }}>Refresh suggestions</Button>
    </div>
    {current.phase === "loading" && <p role="status">Checking assigned projects and current access…</p>}
    {current.phase === "error" && <Message error>Suggestions are unavailable. Refresh to check access and current information.</Message>}
    {queue && <>
      <p className="muted">Review ordering {queue.rankPolicyRevision}; priorities help organize review and do not establish a project health rating.</p>
      {queue.projects.filter((project) => project.update.availability === "UNCONFIGURED").map((project) =>
        <p key={project.projectId}>{project.name}: no update policy was configured as of {project.update.asOf}.</p>)}
      {queue.items.length === 0 ? <p>No schedule or update suggestions were produced from the available observations.</p> :
        <div className="space-y-4">{queue.items.map((pointer) => {
          const project = projects.get(pointer.projectId);
          if (!project) return null;
          const schedule = pointer.facet === "SCHEDULE" ? project.schedule.items[pointer.index] : undefined;
          const update = pointer.facet === "UPDATE" && project.update.availability === "AVAILABLE" ? project.update : undefined;
          const item = schedule ?? update?.suggestion;
          if (!item) return null;
          return <article key={`${pointer.projectId}:${pointer.facet}:${pointer.key}`} className="rounded-lg border border-slate-200 p-4 space-y-2">
            <h3>{project.name} · {pointer.priority} · {pointer.category.replaceAll("_", " ")}</h3>
            <p>Rule-based suggestion — review required.</p>
            <p><strong>Suggested action:</strong> {item.suggestedAction}</p>
            <p><strong>Expected outcome:</strong> {item.expectedOutcome}</p>
            {schedule && <>
              <p className="muted">Schedule evaluated at {project.schedule.asOf}; rule {schedule.triggeringRule.key}@{schedule.triggeringRule.revision}.</p>
              {schedule.trigger.kind === "DELIVERY_SIGNAL" ? <SignalEvidence signal={schedule.trigger.signal} /> : <div className="space-y-2">
                <p>Reported {schedule.trigger.reported.status}; schedule calculation {schedule.trigger.calculated.status}.</p>
                <FactList facts={[schedule.trigger.reported.sourceFact]} />
                {schedule.trigger.objectiveSignals.map((signal) => <SignalEvidence key={signal.signalId} signal={signal} />)}
              </div>}
            </>}
            {update && <>
              <p className="muted">Update evaluated at {update.asOf}; rule {update.suggestion?.ruleRevision}, policy revision {update.policyRevision}.</p>
              <p>Freshness: {update.freshness.state}; source {update.freshness.sourceDateField} at {update.freshness.sourceDate}; threshold {update.thresholdAt}.</p>
              {update.freshness.sourceDateField === "project.createdAt" && <p>Project creation time is a fallback, not a confirmed update.</p>}
              <ul>{update.completeness.factAssessments.map((fact) => <li key={fact.factType}>
                {fact.label}: {fact.state}; authority {fact.sourceAuthorityStatus}; conflict {fact.conflict}.
              </li>)}</ul>
              {update.evidence.length > 0 && <details><summary>Authorized evidence references</summary><ul>{update.evidence.map((evidence) =>
                <li key={`${evidence.factId}:${evidence.versionId}`}>{evidence.factType}: fact {evidence.factId}, version {evidence.versionId}, evidence {evidence.evidenceId}, source {evidence.sourceId}; access revision {evidence.sourceAccessRevision}, authority revision {evidence.authorityRevision ?? "unavailable"}.</li>)}</ul></details>}
            </>}
            <Button className="secondary" onClick={() => openQueueProject(project.projectId)}>Open project</Button>
          </article>;
        })}</div>}
      <section aria-labelledby="blocker-review-heading" className="space-y-3">
        <h3 id="blocker-review-heading">Blocker-age review</h3>
        <p className="muted">Age identifies items to review; it does not establish criticality or assign an owner.</p>
        {queue.projects.map((project) => {
          const facet = project.blockerAge;
          return <div key={project.projectId} className="rounded-lg border border-slate-200 p-4 space-y-2">
            <h4>{project.name}</h4>
            <BlockerAgeObservation facet={facet} />
            <Button className="secondary" onClick={() => openQueueProject(project.projectId)}>Open project</Button>
          </div>;
        })}
      </section>
      <PmReconciliationPreview key={JSON.stringify([scope, subject, state.epoch, queue.projects.map((project) => [project.projectId, project.name])])}
        projects={queue.projects.map((project) => ({ projectId: project.projectId, name: project.name }))}
        subject={subject} requestFactory={requestFactory} openRequest={openQueueRequest} invalidateRef={previewInvalidate}
        isCurrentSession={isCurrentQueue} />
    </>}
  </section>;
}

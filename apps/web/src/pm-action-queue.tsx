import React, { useEffect, useRef, useState } from "react";
import type { PmActionQueue } from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, Message } from "./components.js";
import { FactList, SignalEvidence } from "./delivery-suggestions.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";
import { decodePmQueue } from "./pm-queue-decoder.js";

// EXEC-026: a bounded observation of assigned projects, not a complete queue.
export function PmActionQueuePanel({ scope, request, openProject }: {
  scope: string; request: RequestFn; openProject: (projectId: string) => void;
}) {
  const loader = useRef(request);
  const resource = useRef<ReturnType<typeof createPmQueueResource<PmActionQueue>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<PmActionQueue> }>({ scope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    const driver = createPmQueueResource<PmActionQueue>({
      load: async (signal) => decodePmQueue(await loader.current<unknown>("/pm/action-queue", { signal })),
      publish: (value) => setState({ scope, value }),
      visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [scope]);
  const current = state.scope === scope ? state.value : { phase: "loading" as const };
  const queue = current.phase === "ready" ? current.data : undefined;
  const projects = new Map(queue?.projects.map((project) => [project.projectId, project]) ?? []);
  return <section className="panel space-y-4" aria-labelledby="pm-action-queue-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <span className="eyebrow">ASSIGNED PROJECTS</span>
        <h2 id="pm-action-queue-heading">Action suggestions</h2>
        <p className="muted">Schedule and update information only. Approvals, blocker-age suggestions and other categories are unavailable.
          Schedule suggestions do not assess source authority. Each observation has its own evaluation time; access and data can change.</p>
      </div>
      <Button className="secondary" onClick={() => resource.current?.refresh()}>Refresh suggestions</Button>
    </div>
    {current.phase === "loading" && <p role="status">Checking assigned projects and current access…</p>}
    {current.phase === "error" && <Message error>Suggestions are unavailable. Refresh to check access and current information.</Message>}
    {queue && <>
      <p className="muted">Review ordering {queue.rankPolicyRevision}; priorities help organize review and do not establish a project health rating.</p>
      {queue.projects.filter((project) => project.update.availability === "UNCONFIGURED").map((project) =>
        <p key={project.projectId}>{project.name}: no update policy was configured as of {project.update.asOf}.</p>)}
      {queue.items.length === 0 ? <p>No suggestions were produced from the available observations. Other categories remain unavailable.</p> :
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
            <Button className="secondary" onClick={() => openProject(project.projectId)}>Open project</Button>
          </article>;
        })}</div>}
    </>}
  </section>;
}

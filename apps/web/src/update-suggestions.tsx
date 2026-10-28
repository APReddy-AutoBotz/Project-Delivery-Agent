import React from "react";
import type { UpdateAdviceSnapshot } from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, Message } from "./components.js";
import { useEvidenceResource } from "./evidence-state.js";

export function UpdateSuggestions({ projectId, scope, request }: {
  projectId: string; scope: string; request: RequestFn;
}) {
  const resource = useEvidenceResource(
    `update-suggestions:${projectId}`,
    () => request<UpdateAdviceSnapshot>(`/projects/${projectId}/update-suggestions`),
    scope,
  );
  const advice = resource.data;
  return (
    <section className="panel space-y-4" aria-labelledby="update-suggestions-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="eyebrow">DELIVERY SUGGESTIONS</span>
          <h2 id="update-suggestions-heading">Update information</h2>
          <p className="muted">A point-in-time review of update freshness and required information. Approval items are unavailable.</p>
        </div>
        <Button className="secondary" onClick={() => void resource.refresh()}>Refresh update suggestions</Button>
      </div>
      {resource.phase === "loading" && <p role="status">Checking current access and update information…</p>}
      {resource.phase === "error" && <Message error>Update information is unavailable. Refresh to check current access.</Message>}
      {advice?.availability === "UNCONFIGURED" && <p>No project update policy is configured as of {advice.asOf}.</p>}
      {advice?.availability === "AVAILABLE" && <>
        <p className="muted">Evaluated at {advice.asOf}; policy revision {advice.policyRevision}. Data and access may change.</p>
        <p>Freshness: {advice.freshness.state}. {advice.freshness.sourceDateField === "project.createdAt"
          ? "Project creation time is the fallback, not a confirmed update."
          : "Based on the earliest trusted required-source update."} Source time: {advice.freshness.sourceDate}.</p>
        <p>Freshness threshold for this observation: {advice.thresholdAt}. It may change with the inputs or policy.</p>
        <p>Required information: {advice.completeness.state}.</p>
        <ul>{advice.completeness.factAssessments.map((fact) => <li key={fact.factType}>
          {fact.label} ({fact.factType}): {fact.state}; authority {fact.sourceAuthorityStatus}; conflict {fact.conflict}
          {fact.reasonCodes.length > 0 && `; ${fact.reasonCodes.join(", ")}`}.
        </li>)}</ul>
        {advice.suggestion ? <article className="rounded-lg border border-slate-200 p-4">
          <h3>Review priority: {advice.suggestion.priority} · Update follow-up</h3>
          <p>Rule-based suggestion — review required.</p>
          <p><strong>Suggested action:</strong> {advice.suggestion.suggestedAction}</p>
          <p><strong>Expected outcome:</strong> {advice.suggestion.expectedOutcome}</p>
          <p className="muted">Rule {advice.suggestion.ruleRevision}</p>
        </article> : <p>No update follow-up suggestion was produced from this observation.</p>}
        {advice.evidence.length > 0 && <details><summary>Authorized evidence references</summary>
          <ul>{advice.evidence.map((item) => <li key={`${item.factId}:${item.versionId}`}>
            {item.factType}: fact {item.factId}, version {item.versionId}, evidence {item.evidenceId}, source {item.sourceId}; access revision {item.sourceAccessRevision}, authority revision {item.authorityRevision ?? "unavailable"}; timestamp basis {item.timestampBasis}.
          </li>)}</ul>
        </details>}
      </>}
    </section>
  );
}

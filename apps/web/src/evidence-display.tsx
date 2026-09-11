import React, { useEffect, useState } from "react";
import type {
  AssessmentDelivery,
  FactHistoryEntry,
  ProjectFactValue,
  ActiveAuthorityPolicy,
} from "@pdaa/domain";
import { Button } from "./components.js";
import { savedEvidenceLink } from "./evidence-state.js";

export function FactValue({ value }: { value: ProjectFactValue }) {
  return (
    <span className="fact-value">
      {value.type === "empty" ? "Empty value" : String(value.value)}{" "}
      <small>({value.type})</small>
    </span>
  );
}
export function HistoryEntry({
  entry,
  configure,
  onSource,
}: {
  entry: FactHistoryEntry;
  configure: boolean;
  onSource: (sourceId: string) => void;
}) {
  return (
    <article
      className="evidence-entry"
      aria-label={`History revision ${entry.revision}`}
    >
      <h4>Revision {entry.revision}</h4>
      {entry.visibility === "restricted" ? (
        <p className="evidence-warning">
          Source restricted. Content withheld; revalidation required.
        </p>
      ) : (
        <>
          <FactValue value={entry.content.value} />
          <blockquote>{entry.content.originalStatement}</blockquote>
          <p className="pill neutral">HUMAN_CONFIRMED · Historical statement</p>
          <dl className="evidence-metadata">
            <div>
              <dt>Confirmed by</dt>
              <dd>{entry.content.providedBy}</dd>
            </div>
            <div>
              <dt>Confirmed at</dt>
              <dd>{entry.content.confirmedAt}</dd>
            </div>
            <div>
              <dt>Effective at</dt>
              <dd>{entry.content.effectiveAt}</dd>
            </div>
            <div>
              <dt>Observed at</dt>
              <dd>{entry.content.observedAt}</dd>
            </div>
            <div>
              <dt>Explicit validity ends</dt>
              <dd>{entry.content.validUntil ?? "Not specified"}</dd>
            </div>
            <div>
              <dt>Source record / revision</dt>
              <dd>
                {entry.content.source.recordId} /{" "}
                {entry.content.source.revision}
              </dd>
            </div>
          </dl>
        </>
      )}
      <details>
        <summary>Evidence references</summary>
        <p>Source: {entry.sourceId}</p>
        <p>Evidence: {entry.evidenceId}</p>
        <p>Version: {entry.id}</p>
        <p>Access revision: {entry.sourceAccessRevision}</p>
      </details>
      {configure && (
        <Button className="secondary" onClick={() => onSource(entry.sourceId)}>
          Manage source readers
        </Button>
      )}
    </article>
  );
}
export function PolicyDisplay({ policy }: { policy: ActiveAuthorityPolicy }) {
  return (
    <section className="evidence-policy" aria-label="Active authority rule">
      <h3>Authority rule</h3>
      <p>
        Published revision: {policy.throughRevision ?? 0}. Active revision:{" "}
        {policy.event?.revision ?? "None"}.
      </p>
      {policy.throughRevision !== null &&
        policy.throughRevision !== policy.event?.revision && (
          <p className="evidence-warning">
            Published and active revisions differ. A scheduled revision is not
            necessarily active.
          </p>
        )}
      {policy.event?.state === "ENABLED" && policy.event.definition ? (
        <>
          <p>
            Effective {policy.event.effectiveAt}; recorded{" "}
            {policy.event.recordedAt} by {policy.event.recordedBy}.
          </p>
          <ol>
            {policy.event.definition.tiers.map((tier, index) => (
              <li key={index}>
                Tier {index + 1}
                <ul>
                  {tier.selectors.map((selector) => (
                    <li key={selector.sourceType + selector.instanceId}>
                      {selector.sourceType} ·{" "}
                      {selector.instanceId ?? "All source instances"} ·
                      Approval: {selector.requiredApproval} · Validity:{" "}
                      {selector.validity
                        ? `${selector.validity.durationMs} ms after ${selector.validity.basis}`
                        : "No configured duration"}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <p>
            Conflict behavior: {policy.event.definition.conflictBehavior}.
            Reconciliation assignment is not available in this workflow.
          </p>
        </>
      ) : (
        <p>
          {policy.event?.state === "DISABLED"
            ? "Authority rule disabled."
            : "No active authority rule."}{" "}
          No value is selected without applicable authority.
        </p>
      )}
    </section>
  );
}
export function AssessmentView({
  delivery,
  projectId,
}: {
  delivery: AssessmentDelivery;
  projectId: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const result = delivery.visibility === "available" ? delivery.result : null;
  const elapsed = result?.versions.some(
    (version) =>
      version.visibility === "available" &&
      version.assessment.freshness === "CURRENT" &&
      version.assessedValidUntil !== null &&
      Date.parse(version.assessedValidUntil) <= now,
  );
  return (
    <section className="evidence-assessment" aria-label="Saved assessment">
      <h3>Historical assessment</h3>
      <p>
        <strong>Fact: {result?.scope.factType ?? "Restricted fact"}</strong> ·
        Fact reference: {delivery.factId}
      </p>
      <p>
        <strong>As of {delivery.asOf}</strong>
      </p>
      <p className="evidence-warning">
        This saved assessment describes its capture time. CURRENT means current
        at capture; later changes require a new assessment.
      </p>
      {elapsed && (
        <p role="status" className="evidence-warning">
          Validity has elapsed since this capture. Refresh the assessment before
          using it as current evidence.
        </p>
      )}
      <a href={savedEvidenceLink(projectId, delivery.assessmentId)}>
        Open saved assessment link
      </a>
      {result ? (
        <>
          <p>
            <strong>Outcome: {result.status}</strong>
          </p>
          {result.resolvedValue !== null && (
            <p>
              Value at capture: <FactValue value={result.resolvedValue} />
            </p>
          )}
          {result.revalidationRequired && (
            <p className="evidence-warning">
              Captured evidence requires revalidation. A new capture is needed
              after source access is restored.
            </p>
          )}
          {!result.complete && (
            <p className="evidence-warning">
              History exceeds the complete assessment limit. No partial value
              has been selected.
            </p>
          )}
          {result.reconciliationRequired && (
            <p className="evidence-warning">
              Project-manager reconciliation is needed. A reconciliation request
              has not been created.
            </p>
          )}
          <p>
            Policy revision: {result.policy?.revisionId ?? "None"} · Conflict:{" "}
            {result.conflict}
          </p>
          {result.versions.map((version) => (
            <article
              key={version.id}
              className="evidence-entry"
              aria-label={`Assessed version ${version.id}`}
            >
              {version.visibility === "restricted" ? (
                <p className="evidence-warning">
                  Source restricted in the original capture. Content withheld.
                </p>
              ) : (
                <>
                  <FactValue value={version.value} />
                  <p className="evidence-badges">
                    <strong className="pill neutral">
                      {version.assessment.classification}
                    </strong>
                    <span>Provenance: {version.assessment.provenance}</span>
                    <span>Freshness: {version.assessment.freshness}</span>
                    <span>Conflict: {version.assessment.conflict}</span>
                  </p>
                  {version.assessment.freshness === "STALE" && (
                    <p className="evidence-warning">
                      Expired at capture. This value cannot be presented as
                      current.
                    </p>
                  )}
                  <p>
                    Applicability: {version.temporalApplicability} · Approval:{" "}
                    {version.approvalStateAsOf}
                  </p>
                  <p>
                    Assessed validity ends:{" "}
                    {version.assessedValidUntil ?? "Unknown"}
                  </p>
                  <p>
                    Authority reasons:{" "}
                    {version.eligibilityReasons.join(", ") ||
                      "Eligible at capture"}
                  </p>
                  <p>
                    Source record: {version.source.recordId} · Source revision:{" "}
                    {version.source.revision}
                  </p>
                </>
              )}
              <details>
                <summary>Captured references</summary>
                <p>Version: {version.id}</p>
                <p>Evidence: {version.evidenceIds.join(", ")}</p>
              </details>
            </article>
          ))}
          {result.conflicts.length > 0 && (
            <details>
              <summary>Retained conflicts ({result.conflicts.length})</summary>
              {result.conflicts.map((item, index) => (
                <p key={index}>
                  {item.kind}: {item.versionIds.join(", ")}
                </p>
              ))}
            </details>
          )}
        </>
      ) : (
        <p className="evidence-warning">
          Saved result withheld. Source access or verification changed;
          revalidation required.
        </p>
      )}
    </section>
  );
}

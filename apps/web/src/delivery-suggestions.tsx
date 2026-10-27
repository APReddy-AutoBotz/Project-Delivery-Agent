import React from "react";
import type { ScheduleAdviceSnapshot } from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, Message } from "./components.js";
import { useEvidenceResource } from "./evidence-state.js";

type ScheduleSignal = Extract<
  ScheduleAdviceSnapshot["items"][number]["trigger"],
  { kind: "DELIVERY_SIGNAL" }
>["signal"];
type ScheduleFact = ScheduleSignal["sourceFacts"][number];

function FactList({ facts }: { facts: readonly ScheduleFact[] }) {
  return (
    <ul>
      {facts.map((fact, index) => (
        <li key={`${fact.factType}:${fact.field}:${index}`}>
          {fact.factType} · {fact.field}: {fact.value === null ? "not available" : String(fact.value)}
          {" "}<small>({fact.source.recordType} {fact.source.recordId}, revision {fact.source.revision ?? "unavailable"})</small>
        </li>
      ))}
    </ul>
  );
}

function SignalEvidence({ signal }: { signal: ScheduleSignal }) {
  return (
    <div className="space-y-2">
      <p><strong>{signal.targetKey}</strong> · {signal.kind.replaceAll("_", " ")} · {signal.state}</p>
      <p className="muted">Rule {signal.rule.key}@{signal.rule.revision}</p>
      <ul>
        {signal.rule.parameters.map((parameter) => (
          <li key={parameter.name}>{parameter.name}: {parameter.value === null ? "not available" : String(parameter.value)}</li>
        ))}
      </ul>
      <FactList facts={signal.sourceFacts} />
    </div>
  );
}

// EXEC-022 / FR-ADV-001/006/007: an as-of schedule observation, not a
// complete action queue or a source-authority assessment.
export function DeliverySuggestions({ projectId, scope, request }: {
  projectId: string;
  scope: string;
  request: RequestFn;
}) {
  const resource = useEvidenceResource(
    `delivery-suggestions:${projectId}`,
    () => request<ScheduleAdviceSnapshot>(`/projects/${projectId}/delivery-suggestions`),
    scope,
  );
  const advice = resource.data;
  return (
    <section className="panel space-y-5" aria-labelledby="delivery-suggestions-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="eyebrow">DELIVERY SUGGESTIONS</span>
          <h2 id="delivery-suggestions-heading">Schedule suggestions</h2>
          <p className="muted">
            Schedule only. Source authority has not been assessed by this view.
            Approval items are unavailable because the approval workflow is not available yet.
          </p>
        </div>
        <Button className="secondary" onClick={() => void resource.refresh()}>
          Refresh suggestions
        </Button>
      </div>
      {resource.phase === "loading" && <p role="status">Checking current access and schedule…</p>}
      {resource.phase === "error" && (
        <Message error>Suggestions are unavailable. Refresh to check current access and schedule.</Message>
      )}
      {advice && (
        <>
          <p className="muted">
            Schedule suggestions evaluated at {advice.asOf}. Data or access may change;
            refresh before relying on them.
          </p>
          {advice.items.length === 0 ? (
            <p>No rule-based suggestions were produced from this schedule snapshot. Approval items remain unavailable.</p>
          ) : (
            <div className="space-y-4">
              {advice.items.map((item) => (
                  <article key={item.concernKey} className="rounded-lg border border-slate-200 p-4">
                    <h3>{item.urgency} · {item.category.replaceAll("_", " ")}</h3>
                    <p>Rule-based suggestion — review required.</p>
                    <p><strong>Suggested action:</strong> {item.suggestedAction}</p>
                    <p><strong>Expected outcome:</strong> {item.expectedOutcome}</p>
                    <p className="muted">Rule {item.triggeringRule.key}@{item.triggeringRule.revision}</p>
                    {item.trigger.kind === "DELIVERY_SIGNAL" ? (
                      <SignalEvidence signal={item.trigger.signal} />
                    ) : (
                      <div className="space-y-3">
                        <p>Reported {item.trigger.reported.status}; schedule calculation {item.trigger.calculated.status}.</p>
                        <FactList facts={[item.trigger.reported.sourceFact]} />
                        <p className="muted">
                          Calculation {item.trigger.calculated.rule.key}@{item.trigger.calculated.rule.revision}: {item.trigger.calculated.rationale.text}
                        </p>
                        {item.trigger.objectiveSignals.map((signal) => (
                          <SignalEvidence key={signal.signalId} signal={signal} />
                        ))}
                      </div>
                    )}
                  </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

import React from "react";
import type { BlockerAgeAdvice } from "@pdaa/domain";

type Proof = NonNullable<Extract<BlockerAgeAdvice, { coverage: "COMPLETE" | "PARTIAL" }>["inventory"]>;
function ProofReference({ proof }: { proof: Proof }) {
  return <p>{proof.factType}: fact {proof.factId}, fact revision {proof.factRevision}, policy {proof.policyId},
    policy revision {proof.policyRevisionId} ({proof.policyRevision}); {proof.provenance}, {proof.sourceType}, {proof.freshness},
    conflict {proof.conflict}, validity {proof.validity}; {proof.supports.map((support) => `version ${support.versionId}, evidence ${support.evidenceId}, source ${support.sourceId}, access revision ${support.accessRevision}`).join("; ")}.</p>;
}

export function BlockerAgeObservation({ facet }: { facet: BlockerAgeAdvice }) {
  return <>
    <p>Coverage: {facet.coverage}; evaluated at {facet.asOf}; rule {facet.ruleRevision}; review order {facet.orderRevision}; time zone {facet.timeZone}.</p>
    {facet.coverage === "UNASSESSABLE" ? <p>Blocker-age review is unavailable from the current information and access.</p> : <>
      <p>Threshold: {facet.threshold.minimumBlockerAgeDays} days; policy revision {facet.threshold.revision}.</p>
      <details><summary>Authorized inventory evidence</summary><ProofReference proof={facet.inventory} /></details>
      {facet.noOpenBlockers === true ? <p>No open blockers were established from the current attested inventory.</p> :
        facet.items.length === 0 ? <p>No aged blockers were produced from the assessable information.</p> : null}
      {facet.coverage === "PARTIAL" && <p>Some blocker information could not be assessed.</p>}
      {facet.items.map((item) => <article key={item.raidItemId} className="space-y-1">
        <p><strong>{item.key}</strong> · {item.state.replaceAll("_", " ")} · {item.ageDays} days since {item.sourceDateField}: {item.openedAt} UTC</p>
        <p>{item.suggestedAction} {item.expectedOutcome}</p>
        <details><summary>Authorized evidence references</summary>
          {[item.classification, item.openedAtProof].map((proof) => <ProofReference key={proof.factId} proof={proof} />)}
        </details>
      </article>)}
    </>}
  </>;
}

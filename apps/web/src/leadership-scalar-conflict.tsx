import React, { useEffect, useRef, useState } from "react";
import type { FactCatalogue, ScalarConflictObservation } from "@pdaa/domain";
import { decodeScalarCatalogue, decodeScalarConflict } from "./scalar-conflict-decoder.js";
import { Button, Message } from "./components.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";

type RequestFn = <T>(path: string, init?: RequestInit) => Promise<T>;
type Props = { projectId: string; scope: string; request: RequestFn };

export function LeadershipScalarConflict({ projectId, scope, request }: Props) {
  const loader = useRef(request), resource = useRef<ReturnType<typeof createPmQueueResource<FactCatalogue>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<FactCatalogue> }>({ scope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    const driver = createPmQueueResource<FactCatalogue>({
      load: async (signal) => {
        return decodeScalarCatalogue(await loader.current<unknown>(`/projects/${projectId}/facts`, { signal }));
      }, publish: (value) => setState({ scope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [scope, projectId]);
  const current = state.scope === scope ? state.value : { phase: "loading" as const };
  return <section className="canonical-section" aria-labelledby="scalar-conflict-heading">
    <h3 id="scalar-conflict-heading">Check a date disagreement</h3>
    <p className="muted">Select a project fact to check for a current disagreement between authorized sources. This check does not settle the disagreement or create a request.</p>
    <Button className="secondary" onClick={() => resource.current?.refresh()}>Refresh fact list</Button>
    {current.phase === "loading" && <p role="status">Checking the fact list and access…</p>}
    {current.phase === "error" && <Message error>The fact list is unavailable. Refresh to check current access.</Message>}
    {current.phase === "ready" && <FactSelection key={`${scope}:${current.data.facts.map((row) => row.factId).join(":")}`}
      projectId={projectId} scope={scope} request={request} catalogue={current.data} />}
  </section>;
}

function FactSelection({ projectId, scope, request, catalogue }: Props & { catalogue: FactCatalogue }) {
  const [selected, setSelected] = useState(""), [generation, setGeneration] = useState(0), [submitted, setSubmitted] = useState<number | null>(null);
  const target = catalogue.facts.find((row) => row.factId === selected);
  return <>
    <label htmlFor="scalar-conflict-select">Project fact</label>{" "}
    <select id="scalar-conflict-select" value={target?.factId ?? ""} onChange={(event) => {
      setSubmitted(null); setGeneration((value) => value + 1); setSelected(event.target.value);
    }}>
      <option value="">Select a fact</option>
      {catalogue.facts.map((row) => <option key={row.factId} value={row.factId}>{row.factType}</option>)}
    </select>
    {catalogue.next !== null && <p className="muted">Only the first 50 facts are available for this check.</p>}
    <Button className="secondary" disabled={!target} onClick={() => { setGeneration((value) => value + 1); setSubmitted(generation + 1); }}>Check disagreement</Button>
    {target && submitted !== null && <ScalarObservation key={`${scope}:${target.factId}:${submitted}`} projectId={projectId}
      scope={`${scope}:${target.factId}:${submitted}`} factId={target.factId} factType={target.factType} request={request} />}
  </>;
}

function ScalarObservation({ projectId, scope, request, factId, factType }: Props & { factId: string; factType: string }) {
  const loader = useRef(request), resource = useRef<ReturnType<typeof createPmQueueResource<ScalarConflictObservation>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<ScalarConflictObservation> }>({ scope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    const driver = createPmQueueResource<ScalarConflictObservation>({
      load: async (signal) => {
        return decodeScalarConflict(await loader.current<unknown>(
          `/projects/${projectId}/fact-observations/${factId}/leadership-conflict`, { signal }), projectId, factId, factType);
      }, publish: (value) => setState({ scope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null; };
  }, [scope, projectId, factId, factType]);
  const current = state.scope === scope ? state.value : { phase: "loading" as const };
  return <div aria-live="polite" aria-atomic="true">
    {current.phase === "loading" && <p role="status">Checking current evidence and access…</p>}
    {current.phase === "error" && <Message error>This disagreement is unavailable. Refresh the fact list and try again.</Message>}
    {current.phase === "ready" && <>
      <p>Sources currently disagree. The project manager should reconcile these positions.</p>
      <p className="muted">Checked at {current.data.asOf}; policy revision {current.data.policyRevisionId}. Provenance labels are stored with evidence and do not independently verify a source or a person's confirmation.</p>
      {current.data.positions.map((position) => <div className="canonical-review-row" key={position.value}>
        <p><strong>{position.value}</strong></p>
        <ul>{position.supports.map((row) => <li key={row.versionId}>Evidence {row.evidenceId} · version {row.versionId} · source {row.sourceId} · stored provenance: {row.provenance.replaceAll("_", " ")} · observed {row.observedAt} · valid until {row.assessedValidUntil}</li>)}</ul>
      </div>)}
    </>}
  </div>;
}

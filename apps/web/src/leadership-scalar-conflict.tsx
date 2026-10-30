import React, { useEffect, useRef, useState } from "react";
import type { FactCatalogue, ScalarConflictObservation } from "@pdaa/domain";
import { decodeScalarCatalogue, decodeScalarConflict } from "./scalar-conflict-decoder.js";
import { Button, Message } from "./components.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";

type RequestFn = <T>(path: string, init?: RequestInit) => Promise<T>;
type Props = { projectId: string; scope: string; request: RequestFn };
const maxPageBoundaries = 200;

export function LeadershipScalarConflict({ projectId, scope, request }: Props) {
  const loader = useRef(request), resource = useRef<ReturnType<typeof createPmQueueResource<FactCatalogue>> | null>(null);
  const [navigation, setNavigation] = useState<{ scope: string; projectId: string; after: string | null; visited: string[]; generation: number }>({ scope, projectId, after: null, visited: [], generation: 0 });
  const sameScope = navigation.scope === scope && navigation.projectId === projectId;
  const after = sameScope ? navigation.after : null;
  const visited = sameScope ? navigation.visited : [];
  const pageScope = JSON.stringify([scope, projectId, after, navigation.generation]);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<FactCatalogue> }>({ scope: pageScope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    const driver = createPmQueueResource<FactCatalogue>({
      load: async (signal) => {
        const query = after === null ? "" : `?afterFactType=${encodeURIComponent(after)}`;
        return decodeScalarCatalogue(await loader.current<unknown>(`/projects/${projectId}/facts${query}`, { signal }), after, visited);
      }, publish: (value) => setState({ scope: pageScope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [scope, projectId, after, pageScope]);
  const current = state.scope === pageScope ? state.value : { phase: "loading" as const };
  return <section className="canonical-section" aria-labelledby="scalar-conflict-heading">
    <h3 id="scalar-conflict-heading">Check a date disagreement</h3>
    <p className="muted">Select a project fact to check for a current disagreement between authorized sources. This check does not settle the disagreement or create a request.</p>
    <Button className="secondary" onClick={() => resource.current?.refresh()}>Refresh fact list</Button>
    {current.phase === "loading" && <p role="status">Checking the fact list and access…</p>}
    {current.phase === "error" && <Message error>The fact list is unavailable. Refresh to check current access.</Message>}
    {current.phase === "error" && after !== null && <Button className="secondary" onClick={() => setNavigation((prior) => ({
      scope, projectId, after: null, visited: [], generation: prior.generation + 1,
    }))}>First fact page</Button>}
    {current.phase === "ready" && <>
      <FactSelection key={`${pageScope}:${current.data.facts.map((row) => row.factId).join(":")}`}
        projectId={projectId} scope={pageScope} request={request} catalogue={current.data} after={after} />
      {!current.data.facts.length && <p>No facts on this catalogue page.</p>}
      <div className="actions">
        {after !== null && <Button className="secondary" onClick={() => setNavigation((prior) => ({ scope, projectId, after: null, visited: [], generation: prior.generation + 1 }))}>First fact page</Button>}
        {current.data.next !== null && visited.length < maxPageBoundaries && <Button className="secondary" onClick={() => {
          const next = current.data.next!;
          setNavigation((prior) => ({ scope, projectId, after: next,
            visited: [...(prior.scope === scope && prior.projectId === projectId ? prior.visited : []), next], generation: prior.generation + 1 }));
        }}>Next fact page</Button>}
      </div>
      {current.data.next !== null && visited.length >= maxPageBoundaries && <p className="muted">The navigation limit is reached. Return to the first page to refresh the list.</p>}
      <p className="muted">Fact pages can change as the project changes. Refresh if a selection is no longer available.</p>
    </>}
  </section>;
}

function FactSelection({ projectId, scope, request, catalogue, after }: Props & { catalogue: FactCatalogue; after: string | null }) {
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
    <Button className="secondary" disabled={!target} onClick={() => { setGeneration((value) => value + 1); setSubmitted(generation + 1); }}>Check disagreement</Button>
    {target && submitted !== null && <ScalarObservation key={`${scope}:${target.factId}:${submitted}`} projectId={projectId}
      scope={`${scope}:${target.factId}:${submitted}`} factId={target.factId} factType={target.factType} after={after} request={request} />}
  </>;
}

function ScalarObservation({ projectId, scope, request, factId, factType, after }: Props & { factId: string; factType: string; after: string | null }) {
  const loader = useRef(request), resource = useRef<ReturnType<typeof createPmQueueResource<ScalarConflictObservation>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<ScalarConflictObservation> }>({ scope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    const driver = createPmQueueResource<ScalarConflictObservation>({
      load: async (signal) => {
        const query = after === null ? "" : `?afterFactType=${encodeURIComponent(after)}`;
        return decodeScalarConflict(await loader.current<unknown>(
          `/projects/${projectId}/fact-observations/${factId}/leadership-conflict${query}`, { signal }), projectId, factId, factType);
      }, publish: (value) => setState({ scope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null; };
  }, [scope, projectId, factId, factType, after]);
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

import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EvidenceAdmissionContext, useEvidenceResource } from "../src/evidence-state.js";

type Call = { key: string; resolve: (value: string) => void };
const fixture = window as unknown as { calls: Call[]; commits: Array<{ scope: string; phase: string; data: string | null }> };
fixture.calls = []; fixture.commits = [];
function Resource({ resourceKey, scopeKey }: { resourceKey: string; scopeKey: string }) {
  const old = React.useRef<(() => Promise<void>) | null>(null);
  const resource = useEvidenceResource(resourceKey, () => new Promise<string>((resolve) => fixture.calls.push({ key: resourceKey, resolve })), scopeKey);
  React.useLayoutEffect(() => { fixture.commits.push({ scope: scopeKey, phase: resource.phase, data: resource.data ?? null }); },
    [scopeKey, resource.phase, resource.data]);
  return <>
    <button onClick={() => { old.current = resource.refresh; }}>Capture old refresh</button>
    <button onClick={() => void old.current?.()}>Run old refresh</button>
    <output data-testid="resource">{resource.phase}:{resource.data ?? "none"}</output>
  </>;
}
function App() {
  const [resourceKey, setResourceKey] = React.useState("A");
  const [scopeKey, setScopeKey] = React.useState("scope-A");
  const [admission, setAdmission] = React.useState<object>(() => Object.freeze({}));
  return <>
    <button onClick={() => setResourceKey("A")}>Select A</button>
    <button onClick={() => setResourceKey("B")}>Select B</button>
    <button onClick={() => setScopeKey("scope-B")}>Select scope B</button>
    <button onClick={() => { flushSync(() => setScopeKey("scope-B")); flushSync(() => setScopeKey("scope-A")); }}>Flip scope B then A</button>
    <button onClick={() => setAdmission(Object.freeze({}))}>Renew admission</button>
    <EvidenceAdmissionContext.Provider value={admission}><Resource resourceKey={resourceKey} scopeKey={scopeKey} /></EvidenceAdmissionContext.Provider>
  </>;
}
createRoot(document.getElementById("root")!).render(<App />);

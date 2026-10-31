import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { UnrankedMilestoneView } from "../src/unranked-milestone-view.js";
import { createUnrankedRequestLease } from "../src/unranked-milestone-lease.js";
import { createUnrankedPageLifecycle } from "../src/unranked-page-lifecycle.js";
import { discardResponse, readBoundedJson } from "../src/bounded-json.js";
import type { RequestFn } from "../src/request-types.js";

// Synthetic test harness only. It is not imported by the application or build.
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = "10000000-0000-4000-8000-000000000001", lease = createUnrankedRequestLease(), lifecycle = createUnrankedPageLifecycle();
let sessionGeneration = 1, ignoreAbort = false;
declare global { interface Window { unrankedHarnessSettled?: number; unrankedHarnessBodies?: string[]; unrankedOldSeen?: boolean;
  unrankedReadBytes?: number; unrankedReadCanceled?: boolean; unrankedDenialBytes?: number; unrankedDenialComplete?: boolean;
  unrankedDenialAborted?: boolean; unrankedDenialSignalPresent?: boolean; unrankedHoldDenial?: boolean;
  unrankedDenialHeld?: boolean; unrankedReleaseDenial?: () => void } }
const request: RequestFn = async <T,>(path: string, init: RequestInit = {}, limit?: number, unavailable = () => {}) => {
  const generation = sessionGeneration;
  try {
    const response = await fetch("/api" + path, ignoreAbort ? { ...init, signal: undefined } : init);
    const stream = response.body;
    if (stream) {
      const getReader = stream.getReader.bind(stream), denied = !response.ok;
      if (denied) { window.unrankedDenialBytes = 0; window.unrankedDenialComplete = false; }
      else { window.unrankedReadBytes = 0; window.unrankedReadCanceled = false; }
      stream.getReader = (() => {
        const reader = getReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
        reader.read = async () => {
          const chunk = await read();
          if (denied) {
            if (chunk.done) {
              if (window.unrankedHoldDenial) {
                window.unrankedDenialHeld = true;
                await new Promise<void>((resolve) => { window.unrankedReleaseDenial = resolve; });
              }
              window.unrankedDenialComplete = true;
            } else window.unrankedDenialBytes! += chunk.value.byteLength;
          }
          else if (!chunk.done) window.unrankedReadBytes! += chunk.value.byteLength;
          return chunk;
        };
        reader.cancel = async (reason) => { const output = await cancel(reason); if (!denied) window.unrankedReadCanceled = true; return output; };
        return reader;
      }) as typeof stream.getReader;
    }
    if (!response.ok) {
      unavailable(); await discardResponse(response); window.unrankedDenialSignalPresent = Boolean(init.signal);
      window.unrankedDenialAborted = Boolean(init.signal?.aborted); throw new Error("Unavailable");
    }
    const result = limit === undefined ? await response.json() : await readBoundedJson(response, limit, unavailable);
    if (result && typeof result === "object" && "milestoneId" in result && typeof result.milestoneId === "string")
      window.unrankedHarnessBodies = [...(window.unrankedHarnessBodies ?? []), result.milestoneId];
    if (generation !== sessionGeneration) throw new Error("Session changed");
    return result as T;
  } finally { window.unrankedHarnessSettled = (window.unrankedHarnessSettled ?? 0) + 1; }
};

function Harness() {
  const [selection, setSelection] = useState({ project: id(1), milestone: id(2), generation: 1 });
  const [session, setSession] = useState<{ customerId: string; subject: string; generation: number } | null>(
    { customerId, subject: "synthetic-leader", generation: sessionGeneration });
  return <main>
    <button onClick={() => setSelection((previous) => ({ project: id(1), milestone: id(2), generation: previous.generation + 1 }))}>Select A</button>
    <button onClick={() => setSelection((previous) => ({ project: id(1), milestone: id(3), generation: previous.generation + 1 }))}>Select B</button>
    <button onClick={() => setSelection((previous) => ({ ...previous, milestone: "../invalid", generation: previous.generation + 1 }))}>Select invalid</button>
    <button onClick={() => { sessionGeneration++; setSession({ customerId, subject: "synthetic-leader", generation: sessionGeneration }); }}>Renew session</button>
    <button onClick={() => { sessionGeneration++; setSession(null); }}>Sign out</button>
    <button onClick={() => { ignoreAbort = !ignoreAbort; }}>Toggle ignored abort</button>
    <button onClick={() => lifecycle.dispose()}>Dispose lifecycle</button>
    <UnrankedMilestoneView session={session} selectionGeneration={selection.generation} projectId={selection.project}
      milestoneId={selection.milestone} request={request} lease={lease} lifecycle={lifecycle} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);

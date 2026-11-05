import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { HealthScopeFence } from "../src/health-scope-fence.js";
import { HealthScopeProvider, useHealthScope } from "../src/health-scope-context.js";
import { HealthAssessmentPanel } from "../src/health-assessment.js";
import type { RequestFn } from "../src/request-types.js";

const actor = { customerId: "10000000-0000-4000-8000-000000000001", subject: "synthetic", roles: ["pmo_admin"] };
const projectId = "30000000-0000-4000-8000-000000000001";
const threshold = { revision: 1, minimumBlockerAgeDays: 3, auditRetentionHours: 24, changedBy: "synthetic", changedAt: "2026-10-21T00:00:00.000Z" };
const schedule = { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], changedBy: null, changedAt: null };
let currentThreshold = { ...threshold }, currentSchedule = { ...schedule };
let posts = 0;
let lastPost: { path: string; body: unknown } | null = null;
const request: RequestFn = async <T,>(path: string, init?: RequestInit, _max?: number, _unavailable?: (denied?: boolean) => void, managed?: import("../src/request-types.js").ManagedRequestPolicy): Promise<T> => {
  if (init?.method === "POST") {
    posts++;
    lastPost = { path, body: init.body ? JSON.parse(String(init.body)) : null };
    if (path === "/admin/blocker-age-threshold-policy") {
      const change = JSON.parse(String(init.body));
      currentThreshold = { revision: change.expectedRevision + 1, minimumBlockerAgeDays: change.minimumBlockerAgeDays, auditRetentionHours: change.auditRetentionHours, changedBy: "synthetic", changedAt: "2026-10-21T00:00:00.000Z" };
      return currentThreshold as T;
    }
    if (path === `/projects/${projectId}/schedule-health-policy`) {
      const change = JSON.parse(String(init.body));
      currentSchedule = { revision: change.expectedRevision + 1, timeZone: change.timeZone, defaultMinimumOverdueDays: change.defaultMinimumOverdueDays, targetOverrides: change.targetOverrides, changedBy: null, changedAt: null };
      return currentSchedule as T;
    }
  }
  managed?.completion("eof");
  return (path === "/me" ? actor : path === `/projects/${projectId}` ? { id: projectId }
    : path === "/admin/blocker-age-threshold-policy" ? currentThreshold
      : path === `/projects/${projectId}/schedule-health-policy` ? currentSchedule
        : path.endsWith("/health-assessments/latest") ? null : {}) as T;
};
const fence = new HealthScopeFence(); fence.transition(true);
let admissions = 0;
let lastAdmissionGranted: boolean | null = null;
const beginWrite = fence.beginWrite.bind(fence);
fence.beginWrite = (...args: Parameters<HealthScopeFence["beginWrite"]>) => {
  admissions++; const lease = beginWrite(...args); lastAdmissionGranted = lease !== null; return lease;
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Probe() {
  const scope = useHealthScope(), queryClient = useQueryClient();
  const [configured, setConfigured] = useState(false), [result, setResult] = useState("");
  const key = JSON.stringify(scope.key);
  useEffect(() => {
    if (!scope.ready) return;
    queryClient.setQueryData(["health-assessment-latest", ...scope.key], null);
    queryClient.setQueryData(["canonical-project", ...scope.key], { id: projectId });
    queryClient.setQueryData(["blocker-age-threshold-policy", ...scope.key], currentThreshold);
    queryClient.setQueryData(["schedule-health-policy", ...scope.key], currentSchedule);
    setConfigured(true);
  }, [scope.ready, key, queryClient]);
  async function run(kind: "threshold" | "schedule", stale: boolean, initial = false) {
    const name = kind === "threshold" ? "blocker-age-threshold-policy" : "schedule-health-policy";
    if (initial) queryClient.setQueryData([name, ...scope.key], kind === "threshold" ? null : { ...schedule, revision: 0 });
    if (stale) {
      // QueryClient changes synchronously; this handler retains the previous
      // render's policy revision until React processes the notification.
      queryClient.setQueryData([name, ...scope.key], { ...(kind === "threshold" ? threshold : schedule), revision: 2 });
      const otherScope = [...scope.key]; otherScope[4] = "30000000-0000-4000-8000-000000000002";
      queryClient.setQueryData([name, ...otherScope], kind === "threshold" ? threshold : schedule);
    }
    const lease = scope.beginWrite({ kind, revision: initial ? 0 : 1 });
    if (!lease) { setResult(JSON.stringify({ lease: false, posts, uncertain: scope.uncertain })); return; }
    try { await scope.write(lease, `/projects/${projectId}/synthetic-policy`, { method: "POST" }); }
    finally { scope.finishWrite(lease); setResult(JSON.stringify({ lease: true, posts, uncertain: scope.uncertain })); }
  }
  function staleForm(kind: "threshold" | "schedule") {
    const name = kind === "threshold" ? "blocker-age-threshold-policy" : "schedule-health-policy";
    if (kind === "threshold") currentThreshold = { ...currentThreshold, revision: 2 };
    else currentSchedule = { ...currentSchedule, revision: 2 };
    queryClient.setQueryData([name, ...scope.key], kind === "threshold" ? currentThreshold : currentSchedule);
    const label = kind === "threshold" ? "Save customer threshold" : "Save project schedule policy";
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    const form = button?.closest("form");
    if (!button || button.disabled || !form) throw new Error("Synthetic policy form is unavailable");
    let submissions = 0; const beforeAdmissions = admissions; lastAdmissionGranted = null;
    form.addEventListener("submit", () => { submissions++; }, { capture: true, once: true });
    button.click();
    setResult(JSON.stringify({ lease: fence.writing(), posts, uncertain: scope.uncertain, submissions, admissions: admissions - beforeAdmissions, granted: lastAdmissionGranted }));
  }
  return <main><p id="ready">{configured && scope.ready ? "ready" : "waiting"}</p>
    <button onClick={() => void run("threshold", true)}>Stale threshold</button>
    <button onClick={() => void run("schedule", true)}>Stale schedule</button>
    <button onClick={() => void run("threshold", false)}>Current threshold</button>
    <button onClick={() => void run("schedule", false)}>Current schedule</button>
    <button onClick={() => void run("threshold", false, true)}>Initial threshold</button>
    <button onClick={() => void run("schedule", false, true)}>Initial schedule</button>
    <button onClick={() => staleForm("threshold")}>Stale threshold form</button>
    <button onClick={() => staleForm("schedule")}>Stale schedule form</button>
    <output id="result">{result}</output><output id="posts">{posts}</output><output id="last-post">{JSON.stringify(lastPost)}</output>
    <HealthAssessmentPanel projectId={projectId} reportedStatus="UNKNOWN" pmoAdmin canInspectMilestone={false} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <HealthScopeProvider fence={fence} actor={actor} projectId={projectId} session={1} request={request} visible isCurrent={() => true}>
    <Probe />
  </HealthScopeProvider>
</QueryClientProvider>);

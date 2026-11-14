import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectUpdateResponse } from "../src/project-update-response.js";
import { discardResponse, readBoundedJson } from "../src/bounded-json.js";
import type { RequestFn } from "../src/request-types.js";

const state = window as unknown as { fixtureCleanups?: number; seed?: (owner: string, scope: string) => void; cached?: (owner: string, scope: string) => boolean };
const request: RequestFn = async <T,>(...args: Parameters<RequestFn>): Promise<T> => {
  const [path, init, limit, unavailable, managed, effects, expected] = args;
  if (managed && !managed.current()) { managed.completion("terminated"); throw new Error("Stale fixture request"); }
  const response = await fetch(`/api${path}`, { ...init, headers: { Authorization: "Bearer strict-synthetic-token", "x-fixture-cleanups": String(state.fixtureCleanups ?? 0) } });
  if (!response.ok || (expected !== undefined && response.status !== expected)) {
    if ((!effects || effects()) && unavailable) unavailable(response.status === 403 || response.status === 404);
    await discardResponse(response, managed?.completion); throw new Error("Fixture request unavailable");
  }
  return await readBoundedJson(response, limit ?? 8 * 1024 * 1024, () => {}, managed?.completion) as T;
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
state.seed = (owner, scope) => client.setQueryData(["project-update-invitation", "20000000-0000-4000-8000-000000000001", owner, scope, 0], { synthetic: true });
state.cached = (owner, scope) => client.getQueriesData({ queryKey: ["project-update-invitation", "20000000-0000-4000-8000-000000000001", owner, scope] })
  .some(([, value]) => value !== undefined);
function Fixture() {
  React.useLayoutEffect(() => () => { state.fixtureCleanups = (state.fixtureCleanups ?? 0) + 1; }, []);
  return <ProjectUpdateResponse locator="20000000-0000-4000-8000-000000000001" customerId="10000000-0000-4000-8000-000000000001"
    subject="strict-actor" ownerScope="strict-owner" admissionScope="strict-admission" request={request} isCurrentScope={() => true} />;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={client}><Fixture /></QueryClientProvider></React.StrictMode>);

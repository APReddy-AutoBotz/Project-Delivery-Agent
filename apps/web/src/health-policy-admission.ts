import { decodeSchedule, decodeThreshold } from "./health-policy-decoder.js";

export type PolicyAdmission = Readonly<{ kind: "threshold" | "schedule"; revision: number }>;
type State = { status: string; fetchStatus: string; data?: unknown } | undefined;

// A same-task UI correctness gate for the two fixed policy callers. The
// server remains responsible for authorization and revision concurrency.
export function policyRevisionMatches(policy: PolicyAdmission, state: State): boolean {
  try {
    if (!policy || (policy.kind !== "threshold" && policy.kind !== "schedule") ||
      !Number.isInteger(policy.revision) || policy.revision < 0 || policy.revision > 2147483646 ||
      !state || state.status !== "success" || state.fetchStatus !== "idle") return false;
    if (policy.kind === "threshold") return (decodeThreshold(state.data)?.revision ?? 0) === policy.revision;
    return decodeSchedule(state.data).revision === policy.revision;
  } catch { return false; }
}

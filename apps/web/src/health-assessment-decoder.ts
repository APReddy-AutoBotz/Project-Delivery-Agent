import type { HealthAssessmentView } from "@pdaa/domain";

const fail = (): never => { throw new Error("The assessment outcome could not be confirmed."); };
const uuid = (value: unknown): value is string => typeof value === "string" && value === value.toLowerCase() &&
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(value);
const recordOrNull = (value: unknown): boolean => value === null || (typeof value === "object" && value !== null && !Array.isArray(value));

// Validate only the original assessment response, not a later GET. This
// matches the wire view's envelope; it does not authorize its contents.
export function decodeAssessmentConfirmation(value: unknown, projectId: string): HealthAssessmentView {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const v = value as Record<string, unknown>;
    const required = ["assessmentId", "projectId", "assessedAt", "coverage", "ruleRevision", "envelopeHash", "contentAvailable", "input", "result", "replayed"];
    const allowed = [...required, "blockerAgeCoverage"], actual = Object.keys(v);
    if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(v, key))) return fail();
    const time = typeof v.assessedAt === "string" ? Date.parse(v.assessedAt) : NaN;
    if (!uuid(v.assessmentId) || !uuid(v.projectId) || v.projectId !== projectId || typeof v.assessedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.assessedAt) || v.assessedAt.startsWith("0000-") ||
      !Number.isFinite(time) || new Date(time).toISOString() !== v.assessedAt ||
      (v.coverage !== "SCHEDULE_ONLY" && v.coverage !== "SCHEDULE_AND_BLOCKER_AGE") ||
      typeof v.ruleRevision !== "string" || !["schedule-health@1", "schedule-health@1+blocker-age@1", "schedule-health@2+blocker-age@1"].includes(v.ruleRevision) ||
      (v.blockerAgeCoverage !== undefined && (typeof v.blockerAgeCoverage !== "string" || !["COMPLETE", "PARTIAL", "UNASSESSABLE"].includes(v.blockerAgeCoverage))) ||
      typeof v.envelopeHash !== "string" || !/^[0-9a-f]{64}$/.test(v.envelopeHash) || typeof v.contentAvailable !== "boolean" ||
      !recordOrNull(v.input) || !recordOrNull(v.result) || typeof v.replayed !== "boolean") return fail();
    return v as HealthAssessmentView;
  } catch { return fail(); }
}

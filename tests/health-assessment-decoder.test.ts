import { expect, it } from "vitest";
import { healthAssessmentViewSchema } from "../packages/domain/src/index.js";
import { decodeAssessmentConfirmation } from "../apps/web/src/health-assessment-decoder.js";

const projectId = "30000000-0000-4000-8000-000000000001";
const valid = { assessmentId: "30000000-0000-4000-8000-000000000101", projectId,
  assessedAt: "2026-10-21T00:00:00.000Z", coverage: "SCHEDULE_ONLY", ruleRevision: "schedule-health@1",
  envelopeHash: "a".repeat(64), contentAvailable: false, input: null, result: null, replayed: false };
const accepts = (value: unknown) => { try { decodeAssessmentConfirmation(value, projectId); return true; } catch { return false; } };

it("matches the assessment wire envelope for valid and malformed confirmations", () => {
  const cases: unknown[] = [valid, { ...valid, replayed: true }, { ...valid, blockerAgeCoverage: "PARTIAL" },
    { ...valid, input: {}, result: {} }, {}, null, { ...valid, assessedAt: "2026-02-30T00:00:00.000Z" },
    { ...valid, assessmentId: "not-an-id" }, { ...valid, envelopeHash: "A".repeat(64) },
    { ...valid, ruleRevision: "unknown" }, { ...valid, blockerAgeCoverage: "unknown" }, { ...valid, input: [] },
    { ...valid, replayed: "yes" }, { ...valid, extra: true }];
  for (const value of cases) expect(accepts(value)).toBe(healthAssessmentViewSchema.safeParse(value).success);
});

it("rejects a schema-valid response for a different project", () => {
  const other = { ...valid, projectId: "30000000-0000-4000-8000-000000000002" };
  expect(healthAssessmentViewSchema.safeParse(other).success).toBe(true);
  expect(() => decodeAssessmentConfirmation(other, projectId)).toThrow("The assessment outcome could not be confirmed.");
});

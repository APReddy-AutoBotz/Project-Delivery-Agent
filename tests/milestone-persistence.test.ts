import { expect, it } from "vitest";
import {
  milestoneConsistencyCaptureSchema,
  milestoneConsistencyReadSchema,
  stateBindingCreateSchema,
} from "../packages/domain/src/index.js";

// FR-EVD-001/004/009/012, FR-MOD-002: callers choose targets and statements,
// never binding identity, authority, source access, clocks or calculated results.
const projectId = "30000000-0000-4000-8000-000000000001";
const targetId = "40000000-0000-4000-8000-000000000001";
const binding = {
  projectId,
  targetId,
  targetKind: "MILESTONE",
  initialState: "COMPLETE",
  idempotencyKey: "binding-contract",
  effectiveAt: "2026-09-12T00:00:00.000Z",
  originalStatement: "Confirmed milestone completion",
};
const capture = {
  projectId,
  milestoneId: targetId,
  enabled: true,
  ruleRevision: "milestone-required-state/v1",
  idempotencyKey: "capture-contract",
};
it.each(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"])(
  "accepts exact bound state %s",
  (initialState) => {
    expect(
      stateBindingCreateSchema.parse({ ...binding, initialState }).validUntil,
    ).toBeNull();
  },
);
it.each(["DONE", "complete", " COMPLETE ", "UNKNOWN", 1, null])(
  "rejects noncanonical bound state %s",
  (initialState) => {
    expect(
      stateBindingCreateSchema.safeParse({ ...binding, initialState }).success,
    ).toBe(false);
  },
);
it.each([
  "factId",
  "factType",
  "bindingId",
  "createdAt",
  "policy",
  "sourceAccess",
])("rejects caller-supplied binding control %s", (field) => {
  expect(
    stateBindingCreateSchema.safeParse({ ...binding, [field]: "forged" })
      .success,
  ).toBe(false);
});
it("rejects an expiry before the statement becomes effective", () => {
  expect(
    stateBindingCreateSchema.safeParse({
      ...binding,
      validUntil: "2026-09-11T00:00:00.000Z",
    }).success,
  ).toBe(false);
});
it.each([
  "asOf",
  "complete",
  "bindings",
  "snapshots",
  "result",
  "subject",
  "requiredWorkItemIds",
])("rejects caller-supplied capture control %s", (field) => {
  expect(
    milestoneConsistencyCaptureSchema.safeParse({ ...capture, [field]: null })
      .success,
  ).toBe(false);
});
it("keeps capture rule identity and historical read shape narrow", () => {
  expect(milestoneConsistencyCaptureSchema.safeParse(capture).success).toBe(
    true,
  );
  expect(
    milestoneConsistencyCaptureSchema.safeParse({
      ...capture,
      ruleRevision: "unreviewed/v2",
    }).success,
  ).toBe(false);
  expect(
    milestoneConsistencyReadSchema.safeParse({
      projectId,
      assessmentId: targetId,
    }).success,
  ).toBe(true);
  expect(
    milestoneConsistencyReadSchema.safeParse({
      projectId,
      assessmentId: targetId,
      sourceAccess: true,
    }).success,
  ).toBe(false);
});

import { describe, expect, it } from "vitest";
import {
  humanStatementSchema,
  factHistoryRequestSchema,
  sourceAccessChangeSchema,
} from "../packages/domain/src/project-facts.js";
const projectId = "30000000-0000-4000-8000-0000000000af";
const request = {
  projectId,
  factType: "project.forecast",
  expectedRevision: 0,
  idempotencyKey: "statement-1",
  value: { type: "date", value: "2026-10-01" },
  effectiveAt: "2026-09-09T00:00:00.000Z",
  originalStatement: "My forecast is 1 October.",
};
describe("Bounded human statement and historical page contracts", () => {
  it("retains the original assertion and gives omitted validity an explicit null", () => {
    expect(humanStatementSchema.parse(request)).toEqual({
      ...request,
      validUntil: null,
    });
  });
  it.each([
    "customerId",
    "providedBy",
    "observedAt",
    "confirmedAt",
    "provenance",
    "sourceId",
    "evidenceId",
  ])("rejects caller-supplied %s", (key) => {
    expect(
      humanStatementSchema.safeParse({ ...request, [key]: "fabricated" })
        .success,
    ).toBe(false);
  });
  it.each([
    { projectId: projectId.toUpperCase() },
    { expectedRevision: -1 },
    { expectedRevision: 2147483647 },
    { idempotencyKey: "a b" },
    { effectiveAt: "2026-02-30T00:00:00.000Z" },
    { effectiveAt: "0000-01-01T00:00:00.000Z" },
    { effectiveAt: "2026-09-09T00:00:00Z" },
    { effectiveAt: "2026-09-09T00:00:00.000+00:00" },
    { validUntil: "2026-09-08T00:00:00.000Z" },
    { originalStatement: " \n\t" },
    { originalStatement: "x".repeat(8193) },
    { originalStatement: "\u0000" },
    { originalStatement: "\ud800" },
    { value: { type: "text", value: "\u0000" } },
    { value: { type: "text", value: "\udfff" } },
    { value: { type: "text", value: "x".repeat(4097) } },
    { value: { type: "number", value: Infinity } },
    { value: { type: "date", value: "2026-02-29" } },
    { value: { type: "date", value: "0000-01-01" } },
    { value: { type: "empty", value: "" } },
  ])("denies invalid or unrepresentable statement fields %#", (patch) => {
    expect(
      humanStatementSchema.safeParse({ ...request, ...patch }).success,
    ).toBe(false);
  });
  it("accepts valid unicode and already expired historical assertions", () => {
    expect(
      humanStatementSchema.safeParse({
        ...request,
        originalStatement: "Confirmed ✅",
        value: { type: "text", value: "完成 ✅" },
        validUntil: request.effectiveAt,
      }).success,
    ).toBe(true);
  });
  it("requires a fixed upper revision once paging begins", () => {
    const target = { projectId, factType: request.factType };
    expect(
      factHistoryRequestSchema.safeParse({ ...target, afterRevision: 2 })
        .success,
    ).toBe(false);
    expect(
      factHistoryRequestSchema.safeParse({
        ...target,
        afterRevision: 2,
        throughRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      factHistoryRequestSchema.safeParse({ ...target, limit: 101 }).success,
    ).toBe(false);
    expect(
      factHistoryRequestSchema.parse({
        ...target,
        afterRevision: 2,
        throughRevision: 3,
      }),
    ).toMatchObject({ limit: 50 });
  });
  it("rejects duplicate readers, unbounded subjects and access revision rewinds", () => {
    const access = {
      projectId,
      sourceId: projectId,
      expectedRevision: 1,
      state: "AVAILABLE",
      readers: ["pm"],
    };
    expect(sourceAccessChangeSchema.safeParse(access).success).toBe(true);
    for (const patch of [
      { readers: ["pm", "pm"] },
      { readers: ["\u0000"] },
      { readers: ["x".repeat(257)] },
      { expectedRevision: 0 },
    ])
      expect(
        sourceAccessChangeSchema.safeParse({ ...access, ...patch }).success,
      ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  authorityPolicyChangeSchema,
  assessmentCaptureSchema,
  authorityDefinitionSchema,
} from "../packages/domain/src/index.js";
import { DatabaseAuthorityRepository } from "../packages/data/dist/index.js";
import { ProjectFactError } from "../packages/domain/dist/index.js";

const projectId = "30000000-0000-4000-8000-000000000001";
const actor = {
  customerId: "10000000-0000-4000-8000-000000000001",
  subject: "pmo",
  roles: ["pmo_admin"] as "pmo_admin"[],
};
const selector = {
  sourceType: "human_statement",
  instanceId: null,
  requiredApproval: "NOT_REQUIRED",
  validity: null,
};
const definition = {
  tiers: [{ selectors: [selector] }],
  conflictBehavior: "RETAIN_CONFLICT",
};
const request = {
  projectId,
  factType: "project.forecast",
  expectedRevision: 0,
  idempotencyKey: "policy",
  effectiveAt: "2026-09-10T00:00:00.000Z",
  definition,
};
describe("Authority persistence input boundaries", () => {
  it("accepts a detached definition or explicit disabling revision", () => {
    expect(authorityPolicyChangeSchema.parse(request)).toEqual(request);
    expect(
      authorityPolicyChangeSchema.parse({ ...request, definition: null })
        .definition,
    ).toBe(null);
    expect(authorityPolicyChangeSchema.parse(request).definition).not.toBe(
      definition,
    );
  });
  it.each([
    "customerId",
    "recordedBy",
    "recordedAt",
    "revisionId",
    "state",
    "approved",
    "asOf",
  ])("rejects caller-owned %s metadata", (field) => {
    expect(
      authorityPolicyChangeSchema.safeParse({ ...request, [field]: "forged" })
        .success,
    ).toBe(false);
  });
  it.each([
    "asOf",
    "policy",
    "complete",
    "approval",
    "provenance",
    "access",
    "result",
  ])("capture rejects %s overrides", (field) => {
    expect(
      assessmentCaptureSchema.safeParse({
        projectId,
        factType: "project.forecast",
        idempotencyKey: "capture",
        [field]: true,
      }).success,
    ).toBe(false);
  });
  it.each([
    null,
    {},
    { ...definition, conflictBehavior: null },
    { ...definition, tiers: [] },
    { ...definition, extra: 1 },
  ])("rejects malformed definition %j", (value) => {
    expect(authorityDefinitionSchema.safeParse(value).success).toBe(false);
  });
  it("rejects wildcard/specific overlap across authority tiers", () => {
    expect(
      authorityDefinitionSchema.safeParse({
        ...definition,
        tiers: [
          definition.tiers[0],
          { selectors: [{ ...selector, instanceId: projectId }] },
        ],
      }).success,
    ).toBe(false);
  });
  it.each([
    "0000-01-01T00:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-09-10",
    "2026-09-10T00:00:00+00:00",
  ])("rejects invalid persisted effective instant %s", (effectiveAt) => {
    expect(
      authorityPolicyChangeSchema.safeParse({ ...request, effectiveAt })
        .success,
    ).toBe(false);
  });
  it("rejects actor role inflation before opening any transaction", async () => {
    const repository = new DatabaseAuthorityRepository({
      $transaction: () => {
        throw new Error("must not access persistence");
      },
    } as never);
    await expect(
      repository.appendPolicy(
        { ...actor, roles: ["owner"] } as never,
        request as never,
        { correlationId: "test" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("does not return raw database or failed denial audit errors", async () => {
    const raw = new Error("private SQL value");
    for (const failure of [raw, new ProjectFactError("DENIED")]) {
      const repository = new DatabaseAuthorityRepository({
        $transaction: async () => {
          throw failure;
        },
        auditEvent: {
          create: async () => {
            throw raw;
          },
        },
      } as never);
      await expect(
        repository.appendPolicy(actor, request as never, {
          correlationId: "test",
        }),
      ).rejects.toThrow(
        failure === raw
          ? "Authority persistence failed"
          : "Authority audit failed",
      );
    }
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseProjectFactRepository,
} from "../packages/data/dist/index.js";
import type {
  Actor,
  AuthorityDefinition,
  AuthorityPolicyChange,
  AssessmentDelivery,
} from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Authority tests require an isolated synthetic database");
const db = createDatabase(url),
  secondDb = createDatabase(url);
const authority = new DatabaseAuthorityRepository(db),
  facts = new DatabaseProjectFactRepository(db);
const customerId = process.env.CUSTOMER_ID!;
const context = { correlationId: "authority-integration" };
const factType = "project.forecast";
// Each immutable fact append is one statement: the existing AFTER trigger
// advances its aggregate after the statement. Bulk fixtures must honor that.
async function appendFixtureVersions(
  tx: import("../packages/data/src/generated/prisma/client.js").Prisma.TransactionClient,
  factId: string,
  numeric: boolean,
) {
  await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pg_temp.append_authority_fixture(fid uuid, numeric_values boolean) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE item record; next_revision integer;
    BEGIN
      SELECT revision+1 INTO next_revision FROM public."ProjectFact" WHERE id=fid;
      FOR item IN SELECT e.* FROM public."FactEvidence" e WHERE e."factId"=fid AND NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" v WHERE v."evidenceId"=e.id) ORDER BY e.id LOOP
        INSERT INTO public."ProjectFactVersion" (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,"effectiveAt")
          VALUES (gen_random_uuid(),item."customerId",item."projectId",item."factId",item."sourceId",item.id,next_revision,
            CASE WHEN numeric_values THEN jsonb_build_object('type','number','value',next_revision) ELSE '{"type":"date","value":"2026-10-01"}'::jsonb END,'2026-09-01'::timestamptz);
        next_revision := next_revision+1;
      END LOOP;
    END;
    $$`);
  await tx.$executeRaw`SELECT pg_temp.append_authority_fixture(${factId}::uuid,${numeric})`;
}
const definition: AuthorityDefinition = {
  tiers: [
    {
      selectors: [
        {
          sourceType: "human_statement",
          instanceId: null,
          requiredApproval: "NOT_REQUIRED",
          validity: { basis: "observedAt", durationMs: 86400000 },
        },
      ],
    },
  ],
  conflictBehavior: "REQUEST_RECONCILIATION",
};
afterAll(async () => {
  await db.$disconnect();
  await secondDb.$disconnect();
});
async function fixture() {
  const projectId = randomUUID(),
    portfolioId = randomUUID();
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Authority test" },
  });
  await db.project.create({
    data: {
      id: projectId,
      customerId,
      portfolioId,
      code: "AUTH-" + projectId,
      name: "Authority test",
      description: "Synthetic",
      reportedStatus: "UNKNOWN",
    },
  });
  const pm: Actor = {
    subject: "pm-" + randomUUID(),
    customerId,
    roles: ["project_manager"],
  };
  const pmo: Actor = {
    subject: "pmo-" + randomUUID(),
    customerId,
    roles: ["pmo_admin"],
  };
  const reader: Actor = {
    subject: "reader-" + randomUUID(),
    customerId,
    roles: ["leadership"],
  };
  for (const actor of [pm, pmo, reader])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "project",
        scopeId: projectId,
        role: actor.roles[0]!,
      },
    });
  const policy: AuthorityPolicyChange = {
    projectId,
    factType,
    expectedRevision: 0,
    idempotencyKey: "initial-policy",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    definition,
  };
  return { projectId, portfolioId, pm, pmo, reader, policy };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function append(
  f: Fixture,
  actor = f.pm,
  value = "2026-10-01",
  expectedRevision = 0,
  validity: string | null = null,
) {
  const result = await facts.appendHumanStatement(
    actor,
    {
      projectId: f.projectId,
      factType,
      expectedRevision,
      idempotencyKey: randomUUID(),
      value: { type: "date", value },
      effectiveAt: "2026-09-01T00:00:00.000Z",
      validUntil: validity,
      originalStatement: "Private forecast " + value,
    },
    context,
  );
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId: result.entry.sourceId,
      expectedRevision: result.entry.sourceAccessRevision,
      state: "AVAILABLE",
      readers: [f.pm.subject, f.pmo.subject, f.reader.subject],
    },
    context,
  );
  return result;
}
const capture = (f: Fixture, key = randomUUID(), actor = f.pmo) =>
  authority.captureAssessment(
    actor,
    { projectId: f.projectId, factType, idempotencyKey: key },
    context,
  );
function available(result: AssessmentDelivery) {
  if (result.visibility !== "available")
    throw new Error("Expected available assessment");
  return result.result;
}
async function counts(projectId: string) {
  return {
    policies: await db.authorityPolicy.count({ where: { projectId } }),
    events: await db.authorityPolicyRevision.count({ where: { projectId } }),
    receipts: await db.authorityPolicyReceipt.count({ where: { projectId } }),
    assessments: await db.factAssessment.count({ where: { projectId } }),
    conflicts: await db.factAuthorityConflict.count({ where: { projectId } }),
  };
}
describe("Durable authority policy and server assessment", () => {
  it("rejects an out-of-range policy deadline before an earlier explicit expiry can hide it", async () => {
    const f = await fixture();
    await append(f, f.pm, "2026-10-01", 0, "2026-12-01T00:00:00.000Z");
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        definition: {
          ...definition,
          tiers: [
            {
              selectors: [
                {
                  ...definition.tiers[0]!.selectors[0]!,
                  validity: {
                    basis: "effectiveAt",
                    durationMs: Number.MAX_SAFE_INTEGER,
                  },
                },
              ],
            },
          ],
        },
      },
      context,
    );
    const before = await counts(f.projectId);
    await expect(capture(f)).rejects.toThrow("Authority persistence failed");
    expect(await counts(f.projectId)).toEqual(before);
  });
  it.each([100000000000001, 100000000000003])(
    "preserves exact millisecond expiry for accepted duration %s",
    async (durationMs) => {
      const f = await fixture();
      await append(f);
      await authority.appendPolicy(
        f.pmo,
        {
          ...f.policy,
          definition: {
            ...definition,
            tiers: [
              {
                selectors: [
                  {
                    ...definition.tiers[0]!.selectors[0]!,
                    validity: { basis: "effectiveAt", durationMs },
                  },
                ],
              },
            ],
          },
        },
        context,
      );
      const saved = await capture(f);
      const result = available(saved);
      expect(result.status).toBe("RESOLVED");
      expect(result.versions[0]).toMatchObject({
        assessedValidUntil: new Date(
          Date.parse("2026-09-01T00:00:00.000Z") + durationMs,
        ).toISOString(),
      });
      // Historical validation must also remain independent of the connection's DST zone.
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/New_York'");
        expect(
          (
            await tx.$queryRaw<
              { valid: boolean }[]
            >`SELECT public.valid_fact_assessment(${saved.assessmentId}::uuid) AS valid`
          )[0]!.valid,
        ).toBe(true);
      });
    },
  );
  it("publishes actor-derived immutable policy history and serializes identical and competing retries", async () => {
    const f = await fixture();
    const results = await Promise.all([
      authority.appendPolicy(f.pmo, f.policy, context),
      authority.appendPolicy(f.pmo, { ...f.policy }, context),
    ]);
    expect(results.map((row) => row.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.event).toEqual(results[1]!.event);
    expect(results[0]!.event.recordedBy).toBe(f.pmo.subject);
    const before = await counts(f.projectId);
    await expect(
      authority.appendPolicy(f.pmo, { ...f.policy, definition: null }, context),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await counts(f.projectId)).toEqual(before);
    const competing = await Promise.allSettled(
      ["a", "b"].map((idempotencyKey) =>
        authority.appendPolicy(
          f.pmo,
          {
            ...f.policy,
            expectedRevision: 1,
            idempotencyKey,
            definition: null,
          },
          context,
        ),
      ),
    );
    expect(competing.filter((row) => row.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(competing.find((row) => row.status === "rejected")).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    expect(
      (
        await db.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_authority_history(${results[0]!.event.policyId}::uuid) AS valid`
      )[0]!.valid,
    ).toBe(true);
  });
  it("does not revive an older scheduled policy after a newer eligible disable", async () => {
    const f = await fixture();
    await authority.appendPolicy(f.pmo, f.policy, context);
    const future = new Date(Date.now() + 250).toISOString();
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        expectedRevision: 1,
        idempotencyKey: "scheduled",
        effectiveAt: future,
      },
      context,
    );
    const disabled = await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        expectedRevision: 2,
        idempotencyKey: "disable",
        definition: null,
      },
      context,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(future) - Date.now() + 30)),
    );
    expect(
      (await authority.getActivePolicy(f.pmo, {
        projectId: f.projectId,
        factType,
      }))!.event,
    ).toEqual(disabled.event);
    const reenabled = await authority.appendPolicy(
      f.pmo,
      { ...f.policy, expectedRevision: 3, idempotencyKey: "enable" },
      context,
    );
    expect(
      (await authority.getActivePolicy(f.pmo, {
        projectId: f.projectId,
        factType,
      }))!.event!.id,
    ).toBe(reenabled.event.id);
  });
  it("requires the same current scoped PMO role and allows policy configuration before facts", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const actor of [
      f.pm,
      f.reader,
      { ...f.pmo, roles: ["system_admin"] },
      { ...f.pm, roles: ["pmo_admin"] },
      other.pmo,
    ])
      await expect(
        authority.appendPolicy(actor as Actor, f.policy, context),
      ).rejects.toMatchObject({ code: "DENIED" });
    expect((await counts(f.projectId)).events).toBe(0);
    expect(
      (await authority.appendPolicy(f.pmo, f.policy, context)).event.revision,
    ).toBe(1);
    expect(
      await db.projectFact.count({ where: { projectId: f.projectId } }),
    ).toBe(0);
    expect(
      await authority.getActivePolicy(other.pmo, {
        projectId: f.projectId,
        factType,
      }),
    ).toBe(null);
  });
  it("rejects missing, cross-project and mismatched source-type instance selectors atomically", async () => {
    const f = await fixture(),
      other = await fixture();
    const own = await append(f),
      foreign = await append(other);
    for (const [instanceId, sourceType] of [
      [randomUUID(), "human_statement"],
      [foreign.entry.sourceId, "human_statement"],
      [own.entry.sourceId, "jira"],
    ]) {
      await expect(
        authority.appendPolicy(
          f.pmo,
          {
            ...f.policy,
            definition: {
              ...definition,
              tiers: [
                {
                  selectors: [
                    {
                      ...definition.tiers[0]!.selectors[0]!,
                      instanceId: instanceId!,
                      sourceType: sourceType!,
                    },
                  ],
                },
              ],
            },
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect((await counts(f.projectId)).policies).toBe(0);
  });
  it("captures a trusted complete historical result and replays the original after facts and policy change", async () => {
    const f = await fixture();
    const first = await append(f);
    const policy = await authority.appendPolicy(f.pmo, f.policy, context);
    const saved = await capture(f, "frozen");
    expect(available(saved)).toMatchObject({
      status: "RESOLVED",
      resolvedValue: { type: "date", value: "2026-10-01" },
      mode: "HISTORICAL",
      complete: true,
    });
    expect(available(saved).supportingVersionIds).toEqual([first.entry.id]);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(available(saved))).toBe(true);
    await append(f, f.pm, "2026-11-01", 1);
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        expectedRevision: 1,
        idempotencyKey: "disabled",
        definition: null,
      },
      context,
    );
    const replay = await capture(f, "frozen");
    expect(replay.replayed).toBe(true);
    expect(available(replay)).toEqual(available(saved));
    expect(available(replay).policy!.revisionId).toBe(policy.event.id);
    const current = await capture(f);
    expect(available(current).status).toBe("NO_POLICY");
    expect(
      await db.factAssessmentVersion.count({
        where: { assessmentId: saved.assessmentId },
      }),
    ).toBe(1);
  });
  it("pins a published future policy prefix even when no policy is eligible", async () => {
    const f = await fixture();
    await append(f);
    const published = await authority.appendPolicy(
      f.pmo,
      { ...f.policy, effectiveAt: "2100-01-01T00:00:00.000Z" },
      context,
    );
    const saved = await capture(f);
    expect(available(saved).status).toBe("NO_POLICY");
    expect(
      await db.factAssessment.findUnique({ where: { id: saved.assessmentId } }),
    ).toMatchObject({
      policyId: published.event.policyId,
      policyThroughRevision: 1,
      policyRevisionId: null,
    });
  });
  it("does not treat human confirmation as source approval", async () => {
    const f = await fixture();
    await append(f);
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        definition: {
          ...definition,
          tiers: [
            {
              selectors: [
                {
                  ...definition.tiers[0]!.selectors[0]!,
                  requiredApproval: "APPROVED",
                },
              ],
            },
          ],
        },
      },
      context,
    );
    const result = available(await capture(f));
    expect(result.status).toBe("UNKNOWN");
    expect(result.resolvedValue).toBe(null);
    expect(result.versions[0]).toMatchObject({
      approval: { state: "NOT_REQUIRED" },
      provenance: "HUMAN_CONFIRMED",
      eligibilityReasons: ["APPROVAL_REQUIRED"],
    });
  });
  it("persists differing author conflicts and retains them after policy expiry changes", async () => {
    const f = await fixture();
    await append(f);
    await append(f, f.pmo, "2026-11-01", 1);
    await authority.appendPolicy(f.pmo, f.policy, context);
    const saved = await capture(f),
      original = available(saved);
    expect(original.status).toBe("CONFLICTING");
    expect(
      await db.factAuthorityConflict.count({
        where: { projectId: f.projectId },
      }),
    ).toBe(1);
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        expectedRevision: 1,
        idempotencyKey: "expire",
        definition: {
          ...definition,
          tiers: [
            {
              selectors: [
                {
                  ...definition.tiers[0]!.selectors[0]!,
                  validity: { basis: "effectiveAt", durationMs: 1 },
                },
              ],
            },
          ],
        },
      },
      context,
    );
    const later = available(await capture(f));
    expect(later.status).toBe("CONFLICTING");
    expect(
      later.versions.every(
        (row) =>
          row.visibility === "available" &&
          row.assessment.freshness === "STALE" &&
          row.provenance === "HUMAN_CONFIRMED",
      ),
    ).toBe(true);
    expect(
      available(
        (await authority.getAssessment(f.pmo, {
          projectId: f.projectId,
          assessmentId: saved.assessmentId,
        }))!,
      ),
    ).toEqual(original);
    expect(
      await db.factAuthorityConflict.count({
        where: { projectId: f.projectId },
      }),
    ).toBe(1);
  });
  it.each(["reader", "REVOKED", "DELETED", "UNVERIFIABLE"])(
    "withholds every copied value after current source %s loss, including superseded dependencies",
    async (state) => {
      const f = await fixture();
      const first = await append(f);
      await authority.appendPolicy(f.pmo, f.policy, context);
      const saved = await capture(f, "saved");
      const access = await db.factSourceAccess.findUniqueOrThrow({
        where: { sourceId: first.entry.sourceId },
      });
      await facts.setSourceAccess(
        f.pmo,
        {
          projectId: f.projectId,
          sourceId: access.sourceId,
          expectedRevision: access.revision,
          state: state === "reader" ? "AVAILABLE" : (state as "REVOKED"),
          readers:
            state === "reader" ? [f.pm.subject] : [f.pm.subject, f.pmo.subject],
        },
        context,
      );
      for (const result of [
        await capture(f, "saved"),
        await authority.getAssessment(f.pmo, {
          projectId: f.projectId,
          assessmentId: saved.assessmentId,
        }),
        await capture(f),
      ]) {
        expect(result).toMatchObject({
          visibility: "restricted",
          revalidationRequired: true,
          result: null,
        });
        expect(JSON.stringify(result)).not.toContain("2026-10-01");
      }
    },
  );
  it("never upgrades a redacted frozen result after permissions are granted", async () => {
    const f = await fixture();
    const first = await append(f);
    await authority.appendPolicy(f.pmo, f.policy, context);
    const access = await db.factSourceAccess.findUniqueOrThrow({
      where: { sourceId: first.entry.sourceId },
    });
    await facts.setSourceAccess(
      f.pmo,
      {
        projectId: f.projectId,
        sourceId: access.sourceId,
        expectedRevision: access.revision,
        state: "AVAILABLE",
        readers: [f.pm.subject],
      },
      context,
    );
    const restricted = await capture(f, "redacted");
    expect(restricted.visibility).toBe("restricted");
    const current = await db.factSourceAccess.findUniqueOrThrow({
      where: { sourceId: access.sourceId },
    });
    await facts.setSourceAccess(
      f.pmo,
      {
        projectId: f.projectId,
        sourceId: access.sourceId,
        expectedRevision: current.revision,
        state: "AVAILABLE",
        readers: [f.pm.subject, f.pmo.subject],
      },
      context,
    );
    const restored = available(await capture(f, "redacted"));
    expect(restored.status).toBe("REVALIDATION_REQUIRED");
    expect(restored.resolvedValue).toBe(null);
    expect(available(await capture(f)).status).toBe("RESOLVED");
  });
  it("denies current grant removal and changed-body capture retries without leaking history", async () => {
    const f = await fixture();
    await append(f);
    await authority.appendPolicy(f.pmo, f.policy, context);
    const saved = await capture(f, "saved");
    await expect(
      authority.captureAssessment(
        f.pmo,
        {
          projectId: f.projectId,
          factType: "other.fact",
          idempotencyKey: "saved",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await db.accessGrant.deleteMany({
      where: { customerId, subject: f.pmo.subject },
    });
    expect(
      await authority.getAssessment(f.pmo, {
        projectId: f.projectId,
        assessmentId: saved.assessmentId,
      }),
    ).toBe(null);
    await expect(capture(f, "saved")).rejects.toMatchObject({ code: "DENIED" });
    const audit = await db.auditEvent.findMany({
      where: { actor: f.pmo.subject },
    });
    expect(JSON.stringify(audit)).not.toContain("Private forecast");
    expect(JSON.stringify(audit)).not.toContain("2026-10-01");
  });
  it("SQL forbids sealed history edits, dependency additions and unsealed COMMIT", async () => {
    const f = await fixture();
    await append(f);
    await authority.appendPolicy(f.pmo, f.policy, context);
    const saved = await capture(f),
      original = await db.factAssessment.findUniqueOrThrow({
        where: { id: saved.assessmentId },
      });
    await expect(
      db.factAssessment.update({
        where: { id: original.id },
        data: { result: {} },
      }),
    ).rejects.toThrow();
    await expect(
      db.factAssessment.delete({ where: { id: original.id } }),
    ).rejects.toThrow();
    await expect(
      db.authorityPolicyRevision.updateMany({
        where: { projectId: f.projectId },
        data: { recordedBy: "tampered" },
      }),
    ).rejects.toThrow();
    const link = await db.factAssessmentVersion.findFirstOrThrow({
      where: { assessmentId: original.id },
    });
    await expect(
      db.factAssessmentVersion.deleteMany({
        where: { assessmentId: original.id },
      }),
    ).rejects.toThrow();
    await expect(
      db.factAssessmentVersion.create({ data: link }),
    ).rejects.toThrow();
    const before = await counts(f.projectId);
    await expect(
      db.$transaction(async (tx) => {
        await tx.factAssessment.create({
          data: {
            ...original,
            id: randomUUID(),
            idempotencyKey: randomUUID(),
            sealed: false,
          } as never,
        });
        // Body returns successfully; the deferred COMMIT guard must still reject.
      }),
    ).rejects.toThrow();
    await expect(
      db.factAssessment.create({
        data: {
          ...original,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          sealed: true,
        } as never,
      }),
    ).rejects.toThrow();
    expect(await counts(f.projectId)).toEqual(before);
    expect(
      (
        await db.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_fact_assessment(${original.id}::uuid) AS valid`
      )[0]!.valid,
    ).toBe(true);
  });
  it("SQL rejects copied values that do not match immutable typed dependencies", async () => {
    const f = await fixture();
    await append(f);
    await authority.appendPolicy(f.pmo, f.policy, context);
    const saved = await capture(f),
      original = await db.factAssessment.findUniqueOrThrow({
        where: { id: saved.assessmentId },
      });
    const links = await db.factAssessmentVersion.findMany({
      where: { assessmentId: original.id },
    });
    const result = structuredClone(original.result) as any;
    result.versions[0].value = { type: "text", value: "forged copied secret" };
    await expect(
      db.$transaction(async (tx) => {
        const id = randomUUID();
        await tx.factAssessment.create({
          data: {
            ...original,
            id,
            idempotencyKey: randomUUID(),
            result,
            sealed: false,
          } as never,
        });
        await tx.factAssessmentVersion.createMany({
          data: links.map((row) => ({ ...row, assessmentId: id })),
        });
        await tx.factAssessment.update({
          where: { id },
          data: { sealed: true },
        });
      }),
    ).rejects.toThrow();
  });
  it.each([
    "approval",
    "cleared-reasons",
    "tier",
    "expiry",
    "applicability",
    "status-type",
    "revalidation-type",
    "conflict",
    "reconciliation",
    "candidate-duplicate",
  ])("SQL denies forged captured authority claims: %s", async (mutation) => {
    const f = await fixture();
    await append(f);
    const requiresApproval =
      mutation === "approval" || mutation === "cleared-reasons";
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        definition: requiresApproval
          ? {
              ...definition,
              tiers: [
                {
                  selectors: [
                    {
                      ...definition.tiers[0]!.selectors[0]!,
                      requiredApproval: "APPROVED",
                    },
                  ],
                },
              ],
            }
          : definition,
      },
      context,
    );
    const saved = await capture(f);
    const original = await db.factAssessment.findUniqueOrThrow({
      where: { id: saved.assessmentId },
    });
    const links = await db.factAssessmentVersion.findMany({
      where: { assessmentId: original.id },
    });
    const result = structuredClone(original.result) as any;
    const version = result.versions[0];
    if (requiresApproval) {
      expect(result.status).toBe("UNKNOWN");
      result.status = "RESOLVED";
      result.selectedTier = 0;
      result.candidateVersionIds = result.supportingVersionIds = [version.id];
      result.supportingEvidenceIds = version.evidenceIds;
      result.resolvedValue = version.value;
      if (mutation === "cleared-reasons") version.eligibilityReasons = [];
    } else if (mutation === "tier") version.authorityTier = 1;
    else if (mutation === "expiry")
      version.assessedValidUntil = "2027-01-01T00:00:00.000Z";
    else if (mutation === "applicability")
      version.temporalApplicability = "SUPERSEDED";
    else if (mutation === "status-type") result.status = ["RESOLVED"];
    else if (mutation === "revalidation-type")
      result.revalidationRequired = "false";
    else if (mutation === "conflict") result.conflict = "CONFLICTING";
    else if (mutation === "reconciliation")
      result.reconciliationRequired = true;
    else result.candidateVersionIds.push(version.id);
    await expect(
      db.$transaction(async (tx) => {
        const id = randomUUID();
        await tx.factAssessment.create({
          data: {
            ...original,
            id,
            idempotencyKey: randomUUID(),
            result,
            sealed: false,
          } as never,
        });
        await tx.factAssessmentVersion.createMany({
          data: links.map((row) => ({ ...row, assessmentId: id })),
        });
        await tx.factAssessment.update({
          where: { id },
          data: { sealed: true },
        });
      }),
    ).rejects.toThrow();
  });
  it("SQL refuses incomplete known-conflict coverage even when supplied joins and JSON agree", async () => {
    const f = await fixture();
    await append(f);
    await append(f, f.pmo, "2026-11-01", 1);
    await authority.appendPolicy(f.pmo, f.policy, context);
    const saved = await capture(f),
      original = await db.factAssessment.findUniqueOrThrow({
        where: { id: saved.assessmentId },
      });
    const links = await db.factAssessmentVersion.findMany({
      where: { assessmentId: original.id },
    });
    const result = structuredClone(original.result) as any;
    result.conflicts = result.conflicts.filter(
      (row: { kind: string }) => row.kind !== "RECORDED",
    );
    for (const row of result.versions) row.unresolvedConflictIds = [];
    await expect(
      db.$transaction(async (tx) => {
        const id = randomUUID();
        await tx.factAssessment.create({
          data: {
            ...original,
            id,
            idempotencyKey: randomUUID(),
            conflictCount: 0,
            result,
            sealed: false,
          } as never,
        });
        await tx.factAssessmentVersion.createMany({
          data: links.map((row) => ({ ...row, assessmentId: id })),
        });
        await tx.factAssessment.update({
          where: { id },
          data: { sealed: true },
        });
      }),
    ).rejects.toThrow(/Invalid assessment seal/);
  });
  it("SQL binds new captures to current prefixes and each source-access revision", async () => {
    const f = await fixture();
    await append(f);
    await authority.appendPolicy(f.pmo, f.policy, context);
    const saved = await capture(f),
      original = await db.factAssessment.findUniqueOrThrow({
        where: { id: saved.assessmentId },
      });
    const link = await db.factAssessmentVersion.findFirstOrThrow({
      where: { assessmentId: original.id },
    });
    await expect(
      db.$transaction(async (tx) => {
        const id = randomUUID();
        await tx.factAssessment.create({
          data: {
            ...original,
            id,
            idempotencyKey: randomUUID(),
            sealed: false,
          } as never,
        });
        await tx.factAssessmentVersion.create({
          data: {
            ...link,
            assessmentId: id,
            sourceAccessRevision: link.sourceAccessRevision + 1,
          },
        });
      }),
    ).rejects.toThrow(/Invalid captured source access revision/);
    await expect(
      db.factAssessment.create({
        data: {
          ...original,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          policyId: null,
          policyThroughRevision: null,
          policyRevisionId: null,
          sealed: false,
        } as never,
      }),
    ).rejects.toThrow(/current publication prefixes/);
    await append(f, f.pm, "2026-11-01", 1);
    await expect(
      db.factAssessment.create({
        data: {
          ...original,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          sealed: false,
        } as never,
      }),
    ).rejects.toThrow(/current publication prefixes/);
    expect(
      (
        await db.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_fact_assessment(${original.id}::uuid) AS valid`
      )[0]!.valid,
    ).toBe(true);
  });
  it("SQL rejects unpublished policies at COMMIT and detects restored counter drift", async () => {
    const f = await fixture();
    await expect(
      db.$transaction(async (tx) => {
        await tx.authorityPolicy.create({
          data: {
            id: randomUUID(),
            customerId,
            projectId: f.projectId,
            factType,
          },
        });
      }),
    ).rejects.toThrow(/Unpublished authority policy cannot commit/);
    const published = await authority.appendPolicy(f.pmo, f.policy, context);
    const rollback = new Error("rollback synthetic restore probe");
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "AuthorityPolicy" DISABLE TRIGGER authority_policy_guard',
        );
        await tx.authorityPolicy.update({
          where: { id: published.event.policyId },
          data: { revision: 2 },
        });
        expect(
          (
            await tx.$queryRaw<
              { valid: boolean }[]
            >`SELECT public.valid_authority_history(${published.event.policyId}::uuid) AS valid`
          )[0]!.valid,
        ).toBe(false);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      (
        await db.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_authority_history(${published.event.policyId}::uuid) AS valid`
      )[0]!.valid,
    ).toBe(true);
  });
  it("captures 1000 versions completely and never resolves a truncated 1001-version history", async () => {
    const f = await fixture(),
      first = await append(f);
    await authority.appendPolicy(f.pmo, f.policy, context);
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`INSERT INTO "FactEvidence" (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
        SELECT gen_random_uuid(),${customerId}::uuid,${f.projectId}::uuid,${first.factId}::uuid,${first.entry.sourceId}::uuid,${f.pm.subject},date_trunc('milliseconds',clock_timestamp()),'Bounded synthetic evidence' FROM generate_series(2,1000)`;
        await appendFixtureVersions(tx, first.factId, false);
      },
      { timeout: 15000 },
    );
    const bounded = available(await capture(f));
    expect(bounded.complete).toBe(true);
    expect(bounded.versions).toHaveLength(1000);
    await append(f, f.pm, "2026-12-01", 1000);
    const oversized = available(await capture(f));
    expect(oversized.status).toBe("INCOMPLETE");
    expect(oversized.resolvedValue).toBe(null);
    expect(oversized.versions).toHaveLength(0);
  }, 30000);
  it("a policy grant revocation that wins its lock denies the waiting append", async () => {
    const f = await fixture();
    let held!: () => void, release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      held = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = secondDb.$transaction(
      async (tx) => {
        await tx.accessGrant.deleteMany({
          where: { customerId, subject: f.pmo.subject },
        });
        held();
        await proceed;
      },
      { timeout: 15000 },
    );
    await acquired;
    const appendResult = authority.appendPolicy(f.pmo, f.policy, context).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const rows = await secondDb.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%AccessGrant%'`;
        if (rows[0]!.n > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
    }
    await holder;
    expect(await appendResult).toMatchObject({ error: { code: "DENIED" } });
    expect((await counts(f.projectId)).policies).toBe(0);
  });
  it("retains the entire prospective conflict batch when a 1000-pair capture overflows", async () => {
    const f = await fixture(),
      first = await append(f);
    const published = await authority.appendPolicy(f.pmo, f.policy, context);
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`INSERT INTO "FactSource" (id,"customerId","projectId","factId","providedBy")
        SELECT gen_random_uuid(),${customerId}::uuid,${f.projectId}::uuid,${first.factId}::uuid,'boundary-'||n FROM generate_series(1,45) n`;
        await tx.$executeRaw`INSERT INTO "FactSourceAccess" ("sourceId","customerId","projectId","factId",state)
        SELECT id,"customerId","projectId","factId",'AVAILABLE' FROM "FactSource" WHERE "factId"=${first.factId}::uuid AND "providedBy" LIKE 'boundary-%'`;
        await tx.$executeRaw`INSERT INTO "FactSourceReader" ("customerId","projectId","factId","sourceId",subject)
        SELECT "customerId","projectId","factId",id,${f.pmo.subject} FROM "FactSource" WHERE "factId"=${first.factId}::uuid AND "providedBy" LIKE 'boundary-%'`;
        await tx.$executeRaw`INSERT INTO "FactEvidence" (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
        SELECT gen_random_uuid(),"customerId","projectId","factId",id,"providedBy",date_trunc('milliseconds',clock_timestamp()),'Bounded conflict evidence' FROM "FactSource" WHERE "factId"=${first.factId}::uuid AND "providedBy" LIKE 'boundary-%'`;
        await appendFixtureVersions(tx, first.factId, true);
        await tx.$executeRaw`WITH pairs AS (
        SELECT l.id AS left_id,r.id AS right_id FROM "ProjectFactVersion" l JOIN "ProjectFactVersion" r ON l."factId"=r."factId" AND l.id<r.id
        WHERE l."factId"=${first.factId}::uuid ORDER BY l.id DESC,r.id DESC LIMIT 1000
      ) INSERT INTO "FactAuthorityConflict" (id,"customerId","projectId","factId","factType","leftVersionId","rightVersionId","policyRevisionId","detectedAt",revision)
        SELECT gen_random_uuid(),${customerId}::uuid,${f.projectId}::uuid,${first.factId}::uuid,${factType},left_id,right_id,${published.event.id}::uuid,date_trunc('milliseconds',clock_timestamp()),row_number() OVER (ORDER BY left_id DESC,right_id DESC)::int FROM pairs ORDER BY left_id DESC,right_id DESC`;
      },
      { timeout: 20000 },
    );
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        expectedRevision: 1,
        idempotencyKey: "approval-required",
        definition: {
          ...definition,
          tiers: [
            {
              selectors: [
                {
                  ...definition.tiers[0]!.selectors[0]!,
                  requiredApproval: "APPROVED",
                },
              ],
            },
          ],
        },
      },
      context,
    );
    const complete = await capture(f);
    expect(available(complete).complete).toBe(true);
    expect(available(complete).conflicts).toHaveLength(1000);
    await authority.appendPolicy(
      f.pmo,
      {
        ...f.policy,
        expectedRevision: 2,
        idempotencyKey: "no-separate-approval",
      },
      context,
    );
    const incomplete = await capture(f);
    expect(available(incomplete).status).toBe("INCOMPLETE");
    expect(available(incomplete).resolvedValue).toBe(null);
    expect(
      await db.factAuthorityConflict.count({ where: { factId: first.factId } }),
    ).toBe(1035);
    expect(available(await capture(f)).status).toBe("INCOMPLETE");
    expect(
      (
        await db.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_fact_assessment(${complete.assessmentId}::uuid) AS valid`
      )[0]!.valid,
    ).toBe(true);
  }, 30000);
});

import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
  createDatabase,
  DatabaseProjectRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseAuthorityRepository,
  DatabaseProjectFactRepository,
  DatabaseMilestoneReconciliationRepository,
} from "../packages/data/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import type { Prisma } from "../packages/data/dist/generated/prisma/client.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { createApp } from "../apps/api/dist/app.js";
import { compileContract } from "../scripts/validate-openapi.mjs";
import type {
  Actor,
  AuthorityDefinition,
  StateBindingCreate,
  CanonicalStateBindingView,
} from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname))
  throw new Error(
    "Reconciliation integration requires an isolated synthetic database",
  );
const db = createDatabase(url),
  customerId = process.env.CUSTOMER_ID!;
const canonical = new DatabaseCanonicalProjectRepository(db),
  authority = new DatabaseAuthorityRepository(db),
  facts = new DatabaseProjectFactRepository(db),
  reconciliation = new DatabaseMilestoneReconciliationRepository(db);
const context = { correlationId: "reconciliation-integration" };
const definition: AuthorityDefinition = {
  tiers: [
    {
      selectors: [
        {
          sourceType: "human_statement",
          instanceId: null,
          requiredApproval: "NOT_REQUIRED",
          validity: null,
        },
      ],
    },
  ],
  conflictBehavior: "REQUEST_RECONCILIATION",
};
const config = loadConfig(process.env);
let app: Awaited<ReturnType<typeof createApp>>["app"],
  spec: Awaited<ReturnType<typeof createApp>>["spec"],
  validate: ReturnType<typeof compileContract>,
  base: string;
beforeAll(async () => {
  ({ app, spec } = await createApp(
    config,
    new DatabaseProjectRepository(db),
    undefined,
    canonical,
    facts,
    authority,
    reconciliation,
  ));
  validate = compileContract(spec);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});
async function api(
  actor: Actor | null,
  path: string,
  method = "GET",
  body?: unknown,
  expires = "5m",
) {
  const credential = actor
    ? await new SignJWT({ roles: actor.roles })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(actor.subject)
        .setIssuer("pdaa:local")
        .setAudience("pdaa:api")
        .setIssuedAt()
        .setExpirationTime(expires)
        .sign(new TextEncoder().encode(config.SESSION_SECRET))
    : null;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(credential ? { Authorization: "Bearer " + credential } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const pathname = path.split("?")[0]!;
  const route =
    Object.keys(spec.paths).find((template) => template === pathname) ??
    Object.keys(spec.paths).find((template) =>
      new RegExp("^" + template.replace(/\{[A-Za-z]+\}/g, "[^/]+") + "$").test(
        pathname,
      ),
    )!;
  const text = await response.text();
  const result = validate.response(
    method,
    route,
    response.status,
    response.headers.get("content-type"),
    text,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  return { status: response.status, body: result };
}

async function fixture(
  pmCount = 1,
  grantPm = true,
  bindingThroughHttp = false,
  lastWorkComplete = false,
) {
  const portfolioId = randomUUID();
  const pm: Actor = {
    customerId,
    subject: "reconciliation-pm-" + randomUUID(),
    roles: ["project_manager"],
  };
  const pmo: Actor = {
    customerId,
    subject: "reconciliation-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Reconciliation tests" },
  });
  for (const actor of grantPm ? [pmo, pm] : [pmo])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: actor.roles[0]!,
      },
    });
  const input = canonicalFixture(portfolioId);
  input.responsibilities = Array.from({ length: pmCount }, (_, index) => ({
    role: "PROJECT_MANAGER",
    subject: index === 0 ? pm.subject : "other-pm-" + randomUUID(),
    displayName: "Configured PM",
  }));
  input.raidItems = [];
  input.sourceMappings = [];
  input.workItems = [1, 2, 3].map((index) => ({
    ...input.workItems[0],
    key: "WI-" + index,
  }));
  input.requiredWorkItems = [1, 2, 3].map((index) => ({
    milestoneKey: "MS-1",
    workItemKey: "WI-" + index,
  }));
  const project = await canonical.createProject(
    pmo,
    input,
    context.correlationId,
  );
  const milestone = await db.milestone.findFirstOrThrow({
    where: { projectId: project.id },
    orderBy: { id: "asc" },
  });
  const links = await db.requiredWorkItem.findMany({
    where: { projectId: project.id, milestoneId: milestone.id },
    orderBy: { id: "asc" },
  });
  const targets = [
    {
      targetKind: "MILESTONE" as const,
      targetId: milestone.id,
      initialState: "COMPLETE" as const,
    },
    ...links.map((link, index) => ({
      targetKind: "WORK_ITEM" as const,
      targetId: link.workItemId,
      initialState:
        lastWorkComplete && index === links.length - 1
          ? ("COMPLETE" as const)
          : ("OPEN" as const),
    })),
  ];
  const bindings = [];
  const createBinding = async (
    input: StateBindingCreate,
  ): Promise<CanonicalStateBindingView> => {
    if (!bindingThroughHttp)
      return reconciliation.createStateBinding(pmo, input, context);
    const result = await api(
      pmo,
      `/api/projects/${project.id}/state-bindings`,
      "POST",
      input,
    );
    expect(result.status).toBe(201);
    return result.body;
  };
  for (const target of targets) {
    const bound = await createBinding({
      projectId: project.id,
      ...target,
      idempotencyKey: randomUUID(),
      effectiveAt: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      originalStatement: "Synthetic confirmed " + target.initialState,
    });
    await authority.appendPolicy(
      pmo,
      {
        projectId: project.id,
        factType: bound.factType,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        effectiveAt: "2026-09-01T00:00:00.000Z",
        definition,
      },
      context,
    );
    await facts.setSourceAccess(
      pmo,
      {
        projectId: project.id,
        sourceId: bound.entry.sourceId,
        expectedRevision: bound.entry.sourceAccessRevision,
        state: "AVAILABLE",
        readers: [pmo.subject, pm.subject],
      },
      context,
    );
    bindings.push(bound);
  }
  const check = {
    projectId: project.id,
    milestoneId: milestone.id,
    ruleRevision: "milestone-required-state/v1" as const,
    enabled: true,
    idempotencyKey: randomUUID(),
  };
  return {
    projectId: project.id,
    portfolioId,
    milestone,
    pm,
    pmo,
    bindings,
    check,
  };
}

async function reconciliationRows(projectId: string, includeAudit = true) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    "MilestoneConsistencyAssessment",
    "MilestoneConsistencyTarget",
    "MilestoneConsistencyContributorVersion",
    "FactAssessment",
    "FactAssessmentVersion",
    "FactAssessmentConflict",
    "FactAuthorityConflict",
    "MilestoneReconciliationRequest",
    "MilestoneReconciliationCheck",
    "MilestoneReconciliationAssignment",
    ...(includeAudit ? ["AuditEvent"] : []),
  ]) {
    const predicate =
      table === "AuditEvent"
        ? `detail->>'projectId'=$1`
        : `"projectId"=$1::uuid`;
    rows[table] = await db.$queryRawUnsafe(
      `SELECT to_jsonb(t)::text AS row FROM "${table}" t WHERE ${predicate} ORDER BY to_jsonb(t)::text COLLATE "C"`,
      projectId,
    );
  }
  return rows;
}

it("NFR-REL-002: a test-only occupied-hash lookup with unequal identity rolls back every proof family", async () => {
  const f = await fixture();
  const existing = await reconciliation.check(f.pmo, f.check, context);
  const before = await reconciliationRows(f.projectId);
  let lookupCount = 0;
  // Read shim only: this is NOT a generated SHA-256 collision or SQL guard
  // bypass. The real capture/transaction/COMMIT options remain unchanged.
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === "$transaction")
        return (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: Parameters<typeof db.$transaction>[1],
        ) =>
          target.$transaction(
            async (tx) =>
              callback(
                new Proxy(tx, {
                  get(transaction, delegateName) {
                    if (delegateName === "milestoneReconciliationRequest")
                      return new Proxy(
                        transaction.milestoneReconciliationRequest,
                        {
                          get(delegate, operation) {
                            if (operation === "findUnique")
                              return async (
                                input: Parameters<
                                  typeof delegate.findUnique
                                >[0],
                              ) => {
                                expect(
                                  input.where
                                    .customerId_projectId_milestoneId_ruleRevision_contributorHash,
                                ).toMatchObject({
                                  customerId,
                                  projectId: f.projectId,
                                  milestoneId: f.milestone.id,
                                });
                                lookupCount += 1;
                                return {
                                  id: existing.request!.id,
                                  sealed: true,
                                  contributorIdentity:
                                    "test-only unequal occupied identity",
                                };
                              };
                            const value = Reflect.get(delegate, operation);
                            return typeof value === "function"
                              ? value.bind(delegate)
                              : value;
                          },
                        },
                      );
                    const value = Reflect.get(transaction, delegateName);
                    return typeof value === "function"
                      ? value.bind(transaction)
                      : value;
                  },
                }),
              ),
            options,
          );
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    new DatabaseMilestoneReconciliationRepository(observed).check(
      f.pmo,
      { ...f.check, idempotencyKey: randomUUID() },
      context,
    ),
  ).rejects.toThrow("Reconciliation check unavailable");
  expect(lookupCount).toBe(1);
  expect(await reconciliationRows(f.projectId)).toEqual(before);
});

it("FR-EVD-012: changed conflicting contributors create a new OPEN case and retain the original proof", async () => {
  const f = await fixture(),
    first = await reconciliation.check(f.pmo, f.check, context),
    read = { projectId: f.projectId, requestId: first.request!.id },
    original = await reconciliation.get(f.pm, read),
    binding = f.bindings[1]!;
  const appended = await facts.appendHumanStatement(
    f.pmo,
    {
      projectId: f.projectId,
      factType: binding.factType,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      value: { type: "text", value: "OPEN" },
      effectiveAt: "2026-09-02T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      originalStatement:
        "Synthetic newer confirmation of the same OPEN position",
    },
    context,
  );
  const access = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId: appended.entry.sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId: appended.entry.sourceId,
      expectedRevision: access!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject, f.pm.subject],
    },
    context,
  );
  const second = await reconciliation.check(
    f.pmo,
    {
      ...f.check,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect(second.outcome).toBe("CREATED");
  expect(second.request!.id).not.toBe(first.request!.id);
  expect(second.assessment.assessmentId).not.toBe(
    first.assessment.assessmentId,
  );
  expect(
    await reconciliation.check(
      f.pmo,
      {
        ...f.check,
        idempotencyKey: randomUUID(),
      },
      context,
    ),
  ).toMatchObject({ outcome: "REUSED", request: { id: second.request!.id } });
  expect(await reconciliation.get(f.pm, read)).toEqual(original);
  expect(
    await db.milestoneReconciliationRequest.count({
      where: { projectId: f.projectId, state: "OPEN" },
    }),
  ).toBe(2);
});

it("FR-EVD-009: a noncontributing required-work source withholds the whole original PM and creator proof", async () => {
  const f = await fixture(1, true, false, true),
    checked = await reconciliation.check(f.pmo, f.check, context),
    read = { projectId: f.projectId, requestId: checked.request!.id },
    original = await reconciliation.get(f.pm, read),
    binding = f.bindings[3]!;
  if (
    original?.assessment.visibility !== "available" ||
    original.assessment.result.status !== "CONFLICTING"
  )
    throw new Error("Expected complete original conflicting proof");
  const result = original.assessment.result;
  expect(result.evaluations).toHaveLength(4);
  expect(result.contributors).toHaveLength(3);
  expect(result.contributors.some((row) => row.bindingId === binding.id)).toBe(
    false,
  );
  expect(result.dependencies.some((row) => row.bindingId === binding.id)).toBe(
    true,
  );
  const setReaders = async (readers: string[]) => {
    const current = await facts.getSourceAccess(f.pmo, {
      projectId: f.projectId,
      sourceId: binding.entry.sourceId,
    });
    await facts.setSourceAccess(
      f.pmo,
      {
        projectId: f.projectId,
        sourceId: binding.entry.sourceId,
        expectedRevision: current!.revision,
        state: "AVAILABLE",
        readers,
      },
      context,
    );
  };
  await setReaders([]);
  const before = await reconciliationRows(f.projectId);
  const withheld = {
    ...original.assessment,
    visibility: "restricted",
    revalidationRequired: true,
    result: null,
  };
  expect(await reconciliation.get(f.pm, read)).toEqual({
    request: original.request,
    assessment: withheld,
  });
  expect(await reconciliation.check(f.pmo, f.check, context)).toEqual({
    ...checked,
    replayed: true,
    assessment: { ...withheld, replayed: true },
  });
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  await setReaders([f.pmo.subject, f.pm.subject]);
  expect(await reconciliation.get(f.pm, read)).toEqual(original);
});

it("NFR-SEC-001: configured PM equality, exact role and inherited scope are independent HTTP gates", async () => {
  const f = await fixture(),
    other = await fixture(),
    checked = await reconciliation.check(f.pmo, f.check, context),
    prefix = `/api/projects/${f.projectId}/reconciliation-requests`,
    detail = prefix + "/" + checked.request!.id,
    outsider: Actor = {
      ...f.pm,
      subject: "other-authorized-pm-" + randomUUID(),
    };
  await db.accessGrant.create({
    data: {
      customerId,
      subject: outsider.subject,
      scopeType: "project",
      scopeId: f.projectId,
      role: "project_manager",
    },
  });
  const denied = await api(outsider, detail);
  expect(denied.status).toBe(404);
  expect(await api(outsider, prefix)).toEqual(denied);
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.pm.subject },
  });
  for (const wrong of [
    {
      scopeType: "portfolio",
      scopeId: f.portfolioId,
      role: "portfolio_manager",
    },
    {
      scopeType: "portfolio",
      scopeId: other.portfolioId,
      role: "project_manager",
    },
    { scopeType: "project", scopeId: other.projectId, role: "project_manager" },
  ]) {
    const grant = await db.accessGrant.create({
      data: { customerId, subject: f.pm.subject, ...wrong },
    });
    expect(await api(f.pm, detail)).toEqual(denied);
    expect(await api(f.pm, prefix)).toEqual(denied);
    await db.accessGrant.delete({ where: { id: grant.id } });
  }
  await db.accessGrant.create({
    data: {
      customerId,
      subject: f.pm.subject,
      scopeType: "project",
      scopeId: f.projectId,
      role: "project_manager",
    },
  });
  expect((await api(f.pm, detail)).status).toBe(200);
  const before = await reconciliationRows(f.projectId, false);
  for (const role of ["leadership", "system_admin"] as const) {
    const actor: Actor = {
      customerId,
      subject: role + "-" + randomUUID(),
      roles: [role],
    };
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "project",
        scopeId: f.projectId,
        role,
      },
    });
    expect(await api(actor, prefix + "/manage")).toEqual(denied);
    expect(
      await api(
        actor,
        `/api/projects/${f.projectId}/milestone-reconciliation-checks`,
        "POST",
        f.check,
      ),
    ).toEqual(denied);
    expect(
      await api(actor, detail + "/assignment", "POST", {
        projectId: f.projectId,
        requestId: checked.request!.id,
        expectedAssignmentRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).toEqual(denied);
  }
  // Denied attempts may append their designated audit event, never success history.
  expect(await reconciliationRows(f.projectId, false)).toEqual(before);
});

it("AC-HLT-005: one durable request across creators, original proof, explicit assignment and retry receipts", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    reconciliation.check(f.pmo, f.check, context),
    reconciliation.check(
      f.pm,
      { ...f.check, idempotencyKey: randomUUID() },
      context,
    ),
  ]);
  expect([a.outcome, b.outcome].sort()).toEqual(["CREATED", "REUSED"]);
  expect(a.request?.id).toBe(b.request?.id);
  expect(a.assessment.assessmentId).not.toBe(b.assessment.assessmentId);
  expect(a.request).toMatchObject({
    state: "OPEN",
    assignment: {
      revision: 1,
      reason: "ASSIGNED",
      recipientSubject: f.pm.subject,
    },
  });
  const before = await db.milestoneConsistencyAssessment.count({
    where: { projectId: f.projectId },
  });
  expect(await reconciliation.check(f.pmo, f.check, context)).toMatchObject({
    checkId: a.checkId,
    replayed: true,
    request: { id: a.request!.id },
  });
  expect(
    await db.milestoneConsistencyAssessment.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(before);
  await expect(
    reconciliation.check(f.pmo, { ...f.check, enabled: false }, context),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const read = { projectId: f.projectId, requestId: a.request!.id };
  const delivered = await reconciliation.get(f.pm, read);
  expect(delivered?.assessment).toMatchObject({
    visibility: "available",
    historical: true,
    result: { status: "CONFLICTING", contributors: expect.any(Array) },
  });
  if (
    delivered?.assessment.visibility === "available" &&
    delivered.assessment.result.status === "CONFLICTING"
  ) {
    expect(delivered.assessment.result.contributors).toHaveLength(4);
    expect(
      delivered.assessment.result.evaluations.map(
        (entry) => entry.assessment?.resolvedValue,
      ),
    ).toEqual(
      expect.arrayContaining([
        { type: "text", value: "COMPLETE" },
        { type: "text", value: "OPEN" },
      ]),
    );
  }
  expect(await reconciliation.get(f.pmo, read)).toBeNull();
  const refresh = {
    ...read,
    expectedAssignmentRevision: 1,
    idempotencyKey: randomUUID(),
  };
  expect(
    await reconciliation.refreshAssignment(f.pmo, refresh, context),
  ).toMatchObject({
    replayed: false,
    assignment: { revision: 2, recipientSubject: f.pm.subject },
  });
  expect(
    await reconciliation.refreshAssignment(f.pmo, refresh, context),
  ).toMatchObject({ replayed: true, assignment: { revision: 2 } });
  await expect(
    reconciliation.refreshAssignment(
      f.pmo,
      { ...refresh, expectedAssignmentRevision: 2 },
      context,
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const raw = await db.milestoneReconciliationAssignment.findFirstOrThrow({
    where: { requestId: read.requestId, revision: 1 },
  });
  expect(raw).toMatchObject({
    grantSubject: f.pm.subject,
    grantRole: "project_manager",
    grantScopeId: f.portfolioId,
  });
  expect(
    await reconciliation.list(f.pm, { projectId: f.projectId }, "recipient"),
  ).toMatchObject({
    requests: [{ id: read.requestId, assignment: { revision: 2 } }],
    next: null,
    live: true,
  });
});

it.each([
  [0, true, "NO_CONFIGURED_PM"],
  [2, true, "AMBIGUOUS_CONFIGURED_PM"],
  [1, false, "PM_SCOPE_UNAVAILABLE"],
] as const)(
  "retains a pending unassigned case for PM count %i / grant %s",
  async (count, grant, reason) => {
    const f = await fixture(count, grant);
    const checked = await reconciliation.check(f.pmo, f.check, context);
    expect(checked).toMatchObject({
      outcome: "CREATED",
      request: {
        state: "OPEN",
        assignment: { reason, recipientSubject: null },
      },
    });
    expect(
      await reconciliation.get(f.pm, {
        projectId: f.projectId,
        requestId: checked.request!.id,
      }),
    ).toBeNull();
    expect(
      await reconciliation.list(f.pmo, { projectId: f.projectId }, "manage"),
    ).toMatchObject({ requests: [{ id: checked.request!.id }] });
  },
);

it("revalidates all sources and current recipient identity/scope without corrupting saved history", async () => {
  const f = await fixture();
  const checked = await reconciliation.check(f.pmo, f.check, context),
    read = { projectId: f.projectId, requestId: checked.request!.id };
  const sourceId = f.bindings[1]!.entry.sourceId;
  const current = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: current!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject],
    },
    context,
  );
  expect(await reconciliation.get(f.pm, read)).toMatchObject({
    assessment: {
      visibility: "restricted",
      result: null,
      revalidationRequired: true,
    },
    request: { state: "OPEN" },
  });
  expect(
    await reconciliation.get({ ...f.pm, roles: ["portfolio_manager"] }, read),
  ).toBeNull();
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.pm.subject },
  });
  expect(await reconciliation.get(f.pm, read)).toBeNull();
  const validity = await db.$queryRaw<
    { valid: boolean }[]
  >`SELECT public.valid_milestone_reconciliation_request(${read.requestId}::uuid) AS valid`;
  expect(validity).toEqual([{ valid: true }]);
  const refreshed = await reconciliation.refreshAssignment(
    f.pmo,
    { ...read, expectedAssignmentRevision: 1, idempotencyKey: randomUUID() },
    context,
  );
  expect(refreshed.assignment).toMatchObject({
    revision: 2,
    reason: "PM_SCOPE_UNAVAILABLE",
  });
  expect(
    await db.milestoneReconciliationRequest.count({
      where: { projectId: f.projectId, state: "OPEN" },
    }),
  ).toBe(1);
});

it("disabled reevaluation and later non-conflicting facts never close a pending request", async () => {
  const f = await fixture(),
    first = await reconciliation.check(f.pmo, f.check, context);
  const disabled = await reconciliation.check(
    f.pmo,
    { ...f.check, enabled: false, idempotencyKey: randomUUID() },
    context,
  );
  expect(disabled).toMatchObject({
    outcome: "NO_REQUEST",
    request: null,
    assessment: { result: { status: "DISABLED" } },
  });
  const milestone = f.bindings[0]!;
  await facts.appendHumanStatement(
    f.pmo,
    {
      projectId: f.projectId,
      factType: milestone.factType,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      value: { type: "text", value: "OPEN" },
      effectiveAt: "2026-09-02T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      originalStatement: "Synthetic revised open state",
    },
    context,
  );
  const later = await reconciliation.check(
    f.pmo,
    { ...f.check, idempotencyKey: randomUUID() },
    context,
  );
  expect(later).toMatchObject({ outcome: "NO_REQUEST", request: null });
  expect(
    await db.milestoneReconciliationRequest.findUnique({
      where: { id: first.request!.id },
    }),
  ).toMatchObject({ state: "OPEN" });
});

it("an interrupted birth rolls the fresh assessment back with all its child proofs", async () => {
  const f = await fixture();
  // The capture audit insert fails after proof construction. Its entire
  // transaction, including all earlier scalar/target rows, must roll back.
  const occupied = (
    await db.auditEvent.findFirstOrThrow({
      where: { customerId },
      select: { id: true },
    })
  ).id;
  let calls = 0;
  const broken = new DatabaseMilestoneReconciliationRepository(db, () =>
    ++calls === 3 ? occupied : randomUUID(),
  );
  const before = await db.milestoneConsistencyAssessment.count({
    where: { projectId: f.projectId },
  });
  await expect(broken.check(f.pmo, f.check, context)).rejects.toThrow();
  expect(
    await db.milestoneConsistencyAssessment.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(before);
  expect(
    await db.milestoneReconciliationRequest.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(0);
  expect(
    await db.milestoneReconciliationCheck.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(0);
});

it("INT-EVD-004 / INT-HLT-005: real HTTP PM delivery retains the original proof and revalidates identity and every source", async () => {
  const f = await fixture(),
    prefix = `/api/projects/${f.projectId}`;
  const checked = await api(
    f.pmo,
    prefix + "/milestone-reconciliation-checks",
    "POST",
    f.check,
  );
  expect(checked.status).toBe(201);
  expect(checked.body).toMatchObject({
    outcome: "CREATED",
    replayed: false,
    assessment: { result: { status: "CONFLICTING" } },
  });
  const requestId = checked.body.request.id,
    detail = prefix + "/reconciliation-requests/" + requestId;
  expect(
    (
      await api(
        f.pmo,
        prefix + "/milestone-reconciliation-checks",
        "POST",
        f.check,
      )
    ).body,
  ).toMatchObject({ checkId: checked.body.checkId, replayed: true });
  const reused = await api(
    f.pm,
    prefix + "/milestone-reconciliation-checks",
    "POST",
    { ...f.check, idempotencyKey: randomUUID() },
  );
  expect(reused.body).toMatchObject({
    outcome: "REUSED",
    request: { id: requestId },
  });
  expect(reused.body.assessment.assessmentId).not.toBe(
    checked.body.assessment.assessmentId,
  );
  const delivered = await api(f.pm, detail);
  expect(delivered.status).toBe(200);
  expect(delivered.body.assessment.assessmentId).toBe(
    checked.body.assessment.assessmentId,
  );
  expect(delivered.body.assessment.result.contributors).toHaveLength(4);
  expect((await api(f.pmo, detail)).status).toBe(404);
  expect(
    (await api({ ...f.pm, subject: "unassigned-pm-" + randomUUID() }, detail))
      .status,
  ).toBe(404);
  expect(
    (await api({ ...f.pm, roles: ["portfolio_manager"] }, detail)).status,
  ).toBe(404);
  expect((await api(f.pm, detail, "GET", undefined, "-1s")).status).toBe(401);
  expect((await api(null, detail)).status).toBe(401);
  expect(
    (await api(f.pmo, prefix + "/reconciliation-requests/manage")).body
      .requests,
  ).toHaveLength(1);
  expect(
    (await api(f.pm, prefix + "/reconciliation-requests")).body.requests,
  ).toHaveLength(1);
  expect((await api(f.pmo, prefix + "/reconciliation-requests")).status).toBe(
    404,
  );
  const sourceId = f.bindings[3]!.entry.sourceId;
  const accessBeforeRevoke = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: accessBeforeRevoke!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject],
    },
    context,
  );
  const restricted = await api(f.pm, detail);
  expect(restricted.status).toBe(200);
  expect(restricted.body.assessment).toMatchObject({
    visibility: "restricted",
    result: null,
    revalidationRequired: true,
  });
  expect(Object.keys(restricted.body.assessment).sort()).toEqual([
    "asOf",
    "assessmentId",
    "historical",
    "milestoneId",
    "projectId",
    "replayed",
    "result",
    "revalidationRequired",
    "visibility",
  ]);
  const accessBeforeRestore = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: accessBeforeRestore!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject, f.pm.subject],
    },
    context,
  );
  expect((await api(f.pm, detail)).body.assessment.visibility).toBe(
    "available",
  );
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.pm.subject },
  });
  expect((await api(f.pm, detail)).status).toBe(404);
  const refresh = {
    projectId: f.projectId,
    requestId,
    expectedAssignmentRevision: 1,
    idempotencyKey: randomUUID(),
  };
  expect(
    (await api(f.pmo, detail + "/assignment", "POST", refresh)).body,
  ).toMatchObject({
    assignment: { revision: 2, reason: "PM_SCOPE_UNAVAILABLE" },
    replayed: false,
  });
  expect(
    (await api(f.pmo, detail + "/assignment", "POST", refresh)).body,
  ).toMatchObject({ assignment: { revision: 2 }, replayed: true });
  expect(
    (
      await api(f.pmo, detail + "/assignment", "POST", {
        ...refresh,
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await api(f.pmo, detail + "/assignment", "POST", {
        ...refresh,
        recipientSubject: f.pm.subject,
      })
    ).status,
  ).toBe(400);
});

it("FR-MOD-002 / FR-EVD-009: HTTP context is metadata-only and binding creation cannot assert source authority", async () => {
  const f = await fixture(1, true, true),
    prefix = `/api/projects/${f.projectId}`;
  const result = await api(
    f.pmo,
    prefix + `/milestones/${f.milestone.id}/reconciliation-context`,
  );
  expect(result.status).toBe(200);
  expect(result.body.targets).toHaveLength(4);
  expect(Object.keys(result.body.targets[0].binding).sort()).toEqual([
    "factId",
    "factType",
    "id",
  ]);
  // Binding exists already: fresh commands conflict without creating a second fact.
  const command = {
    projectId: f.projectId,
    targetKind: "MILESTONE",
    targetId: f.milestone.id,
    idempotencyKey: randomUUID(),
    initialState: "COMPLETE",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    validUntil: null,
    originalStatement: "Synthetic duplicate binding",
  };
  expect(
    (await api(f.pmo, prefix + "/state-bindings", "POST", command)).status,
  ).toBe(409);
  expect(
    (
      await api(f.pmo, prefix + "/state-bindings", "POST", {
        ...command,
        provenance: "SYSTEM_VERIFIED",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(
        { ...f.pmo, roles: ["leadership"] },
        prefix + "/milestone-reconciliation-checks",
        "POST",
        f.check,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await api(
        f.pmo,
        prefix + "/reconciliation-requests/manage?afterId=" + randomUUID(),
      )
    ).status,
  ).toBe(400);
});

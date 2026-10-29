import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createApp } from "../apps/api/dist/app.js";
import { createDatabase, DatabaseProjectFactRepository, DatabaseProjectRepository, DatabaseProjectUpdateRepository } from "../packages/data/dist/index.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { seedEscalationHistory } from "../scripts/acceptance/escalation-history.mjs";
import { seedExpiredUpdateInvitation } from "./fixtures/expired-update-invitation.js";
import type { Actor } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
  !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Invitation HTTP checks require an isolated synthetic database");
const db = createDatabase(url);
afterAll(async () => db.$disconnect());

it("SEC-UPD-003: authenticates real invitation GET/POST and withholds unauthorized links", async () => {
  // The guard-valid synthetic history creates captured stages directly, independent
  // of the host weekday. It is not evidence of a delivered message.
  const f = await seedEscalationHistory(url, { isolatedCustomer: true });
  const origin = "http://localhost:5173", secret = "synthetic-session-secret-".repeat(4);
  const configFor = (customerId: string) => loadConfig({ ...process.env, NODE_ENV: "test", DATA_MODE: "synthetic",
    AUTH_MODE: "development", CUSTOMER_ID: customerId, APP_ORIGIN: origin, PDAA_DATABASE_URL: url,
    SESSION_SECRET: secret, ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SHADOW_MODE: "false" });
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect((await tx.$queryRawUnsafe<{ current_user: string }[]>("SELECT current_user"))[0]!.current_user).toBe("pdaa_api");
      return operation(tx);
    }, options as never) };
  const updates = new DatabaseProjectUpdateRepository(roleDb as never, f.service, f.zones,
    () => ({ globalShadowMode: "false", configuration: f.configuration }));
  const otherCustomer = randomUUID();
  await db.customer.create({ data: { id: otherCustomer, name: "Synthetic other customer" } });
  const otherEpoch = randomUUID();
  const otherUpdates = new DatabaseProjectUpdateRepository(roleDb as never, f.service, { ...f.zones, customerId: otherCustomer },
    () => ({ globalShadowMode: "false", configuration: { ...f.configuration, customerId: otherCustomer, issuanceEpoch: otherEpoch } }));
  const start = async (customerId: string, repository: DatabaseProjectUpdateRepository) => {
    const created = await createApp(configFor(customerId), new DatabaseProjectRepository(db), undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, repository);
    await created.app.listen(0, "127.0.0.1"); return created.app;
  };
  const app = await start(f.customerId, updates), other = await start(otherCustomer, otherUpdates);
  const token = async (actor: Actor, expiry = "5m", audience = "pdaa:api", key = secret) => new SignJWT({ roles: actor.roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(actor.subject).setIssuer("pdaa:local").setAudience(audience)
    .setIssuedAt().setExpirationTime(expiry).sign(new TextEncoder().encode(key));
  const owner = await token(f.owner), wrongSubject = await token(f.admin), wrongRole = await token({ ...f.owner, roles: ["leadership"] });
  const expiredToken = await token(f.owner, "-1s"), wrongAudience = await token(f.owner, "5m", "other-service"), forged = await token(f.owner, "5m", "pdaa:api", "synthetic-wrong-key-".repeat(4));
  const locator = f.request.locator, canary = "PRIVATE_DENIED_RESPONSE_" + randomUUID();
  const command = { text: "Synthetic unconfirmed HTTP response", idempotencyKey: randomUUID(), correctsResponseId: null };
  const path = (id: string, post: boolean) => `/api/project-update-invitations/${id}${post ? "/responses" : ""}`;
  async function call(server: typeof app, id: string, bearer: string | null, post: boolean, payload: unknown = command) {
    const response = await fetch(await server.getUrl() + path(id, post), { method: post ? "POST" : "GET",
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(post ? { "Content-Type": "application/json", Origin: origin } : {}) },
      ...(post ? { body: JSON.stringify(payload) } : {}) });
    const body = await response.text();
    expect(response.headers.get("cache-control")).toBe("no-store");
    return { status: response.status, body };
  }
  const tables = ["ProjectFact", "ProjectFactVersion", "FactEvidence", "ProjectUpdateResponse", "ProjectUpdateResponseContent",
    "ProjectUpdateEngagement", "ProjectUpdateObligation", "ProjectUpdateStage", "ProjectUpdateOutbox"];
  const snapshot = () => Promise.all([...tables.map((table) => db.$queryRawUnsafe(
    `SELECT to_jsonb(t)::text AS row FROM public."${table}" t WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY to_jsonb(t)::text COLLATE "C"`, f.customerId, f.projectId)),
    db.$queryRawUnsafe(`SELECT to_jsonb(t)::text AS row FROM public."AuditEvent" t WHERE "customerId"=$1::uuid ORDER BY to_jsonb(t)::text COLLATE "C"`, f.customerId)]);
  try {
    const positive = await call(app, locator, owner, false); expect(positive.status).toBe(200);
    expect(JSON.parse(positive.body).requestId).toBe(f.request.requestId);
    const beforePositive = await snapshot();
    const beforeSubmit = await db.projectUpdateResponse.count({ where: { customerId: f.customerId, projectId: f.projectId } });
    const beforeContent = await db.projectUpdateResponseContent.count({ where: { customerId: f.customerId, projectId: f.projectId } });
    const beforeAudit = await db.auditEvent.count({ where: { customerId: f.customerId, event: "project_update.response.recorded" } });
    const saved = await call(app, locator, owner, true); expect(saved.status).toBe(201);
    const receipt = JSON.parse(saved.body); expect(receipt.state).toBe("UNCONFIRMED");
    expect(await db.projectUpdateResponse.count({ where: { customerId: f.customerId, projectId: f.projectId } })).toBe(beforeSubmit + 1);
    expect(await db.projectUpdateResponseContent.count({ where: { customerId: f.customerId, projectId: f.projectId } })).toBe(beforeContent + 1);
    expect(await db.auditEvent.count({ where: { customerId: f.customerId, event: "project_update.response.recorded" } })).toBe(beforeAudit + 1);
    const afterPositive = await snapshot();
    for (const index of [0, 1, 2, 5, 6, 7, 8]) expect(afterPositive[index]).toEqual(beforePositive[index]);
    expect(await call(app, locator, owner, true)).toEqual(saved);
    expect(await snapshot()).toEqual(afterPositive);

    const baseline = await snapshot(), invalidBody = { text: canary, idempotencyKey: randomUUID(), extra: "invalid" };
    expect((await call(app, locator, owner, true, invalidBody)).status).toBe(400);
    const hidden = [canary, f.projectId, f.sourceMarkerA, f.sourceMarkerB, f.privateResponse, locator,
      f.request.requestId, f.request.body, JSON.parse(positive.body).project.name, JSON.parse(positive.body).project.code, receipt.responseId];
    let generic404: string | undefined;
    const checkDenied = (denied: { status: number; body: string }, status: number) => {
      expect(denied.status).toBe(status);
      if (status === 404) { generic404 ??= denied.body; expect(denied.body).toBe(generic404); }
      for (const privateValue of hidden) expect(denied.body).not.toContain(privateValue);
    };
    for (const post of [false, true]) {
      for (const bearer of [null, expiredToken, wrongAudience, forged]) {
        checkDenied(await call(app, locator, bearer, post, invalidBody), 401);
      }
      for (const [server, selected, bearer] of [[app, locator, wrongSubject], [app, locator, wrongRole],
        [app, randomUUID(), owner], [app, "invalid-locator", owner], [other, locator, owner]] as const) {
        checkDenied(await call(server, selected, bearer, post, invalidBody), 404);
      }
    }
    expect(await snapshot()).toEqual(baseline);
    const facts = new DatabaseProjectFactRepository(db);
    const source = await facts.getSourceAccess(f.admin, { projectId: f.projectId, sourceId: f.sourceA.sourceId });
    await facts.setSourceAccess(f.admin, { projectId: f.projectId, sourceId: f.sourceA.sourceId, expectedRevision: source!.revision,
      state: "REVOKED", readers: [] }, { correlationId: randomUUID() });
    const afterRevocation = await snapshot();
    checkDenied(await call(app, locator, owner, false), 404);
    checkDenied(await call(app, locator, owner, true), 404); // same-key replay must reauthorize
    expect(await snapshot()).toEqual(afterRevocation);
    const revoked = await facts.getSourceAccess(f.admin, { projectId: f.projectId, sourceId: f.sourceA.sourceId });
    await facts.setSourceAccess(f.admin, { projectId: f.projectId, sourceId: f.sourceA.sourceId, expectedRevision: revoked!.revision,
      state: "AVAILABLE", readers: f.readers }, { correlationId: randomUUID() });
    expect((await call(app, locator, owner, false)).status).toBe(200);
    await db.accessGrant.deleteMany({ where: { customerId: f.customerId, subject: f.owner.subject, scopeId: f.projectId } });
    const afterGrantRevocation = await snapshot();
    checkDenied(await call(app, locator, owner, false), 404);
    checkDenied(await call(app, locator, owner, true), 404);
    expect(await snapshot()).toEqual(afterGrantRevocation);
  } finally { await Promise.all([app.close(), other.close()]); }
}, 60000);

it("SEC-UPD-003: a persisted expired invitation is denied over real HTTP while a current peer succeeds", async () => {
  const f = await seedExpiredUpdateInvitation(url), origin = "http://localhost:5173", secret = "synthetic-expiry-secret-".repeat(4);
  const config = loadConfig({ ...process.env, NODE_ENV: "test", DATA_MODE: "synthetic", AUTH_MODE: "development", CUSTOMER_ID: f.customerId,
    APP_ORIGIN: origin, PDAA_DATABASE_URL: url, SESSION_SECRET: secret, ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SHADOW_MODE: "false" });
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    expect((await tx.$queryRawUnsafe<{ current_user: string }[]>("SELECT current_user"))[0]!.current_user).toBe("pdaa_api");
    return operation(tx);
  }, options as never) };
  const updates = new DatabaseProjectUpdateRepository(roleDb as never, f.service, f.zones,
    () => ({ globalShadowMode: "false", configuration: f.configuration }));
  const { app } = await createApp(config, new DatabaseProjectRepository(db), undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, updates);
  await app.listen(0, "127.0.0.1");
  const token = await new SignJWT({ roles: f.owner.roles }).setProtectedHeader({ alg: "HS256" }).setSubject(f.owner.subject)
    .setIssuer("pdaa:local").setAudience("pdaa:api").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(secret));
  const canary = "EXPIRED_RESPONSE_CANARY_" + randomUUID();
  async function call(locator: string, post: boolean) {
    const response = await fetch(`${await app.getUrl()}/api/project-update-invitations/${locator}${post ? "/responses" : ""}`,
      { method: post ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`,
        ...(post ? { "Content-Type": "application/json", Origin: origin } : {}) },
      ...(post ? { body: JSON.stringify({ text: canary, idempotencyKey: randomUUID() }) } : {}) });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return { status: response.status, body: await response.text() };
  }
  const tables = ["ProjectFact", "ProjectFactVersion", "FactEvidence", "ProjectUpdateCapturedRequest", "ProjectUpdateInvitation",
    "ProjectUpdateRequestContent", "ProjectUpdateResponse", "ProjectUpdateResponseContent", "ProjectUpdateEngagement",
    "ProjectUpdateObligation", "ProjectUpdateStage", "ProjectUpdateOutbox"];
  const snapshot = () => Promise.all([...tables.map((table) => db.$queryRawUnsafe(
    `SELECT to_jsonb(t)::text AS row FROM public."${table}" t WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY to_jsonb(t)::text COLLATE "C"`, f.customerId, f.projectId)),
    db.$queryRawUnsafe('SELECT to_jsonb(t)::text AS row FROM public."AuditEvent" t WHERE "customerId"=$1::uuid ORDER BY to_jsonb(t)::text COLLATE "C"', f.customerId)]);
  try {
    const peers = await db.$queryRawUnsafe<Array<{ locator: string; recipientSubject: string; issuanceEpoch: string; dependencies: unknown;
      expiresAt: Date; purgeAfter: Date; contentState: string; kind: string; recipientRole: string; generation: number;
      currentGeneration: number; engagementState: string; obligationState: string; policyRevision: number; currentPolicy: number;
      outboxState: string; gateEnabled: boolean; gateEpoch: string; now: Date }>>(`SELECT i.locator,i."recipientSubject",i."issuanceEpoch",i."expiresAt",
      r.dependencies,r."purgeAfter",c.state AS "contentState",s.kind,s."recipientRole",s.generation,s."policyRevision",
      e.generation AS "currentGeneration",e.state AS "engagementState",o.state AS "obligationState",p.revision AS "currentPolicy",
      b.state AS "outboxState",g."issuanceEnabled" AS "gateEnabled",g."issuanceEpoch" AS "gateEpoch",clock_timestamp() AS now
      FROM public."ProjectUpdateInvitation" i JOIN public."ProjectUpdateCapturedRequest" r ON r.id=i."requestId"
      JOIN public."ProjectUpdateRequestContent" c ON c."requestId"=r.id JOIN public."ProjectUpdateStage" s ON s.id=r."stageId"
      JOIN public."ProjectUpdateEngagement" e ON e.id=s."engagementId" JOIN public."ProjectUpdateObligation" o ON o.id=e."obligationId"
      JOIN public."ProjectUpdatePolicy" p ON p."customerId"=e."customerId" AND p."projectId"=e."projectId"
      JOIN public."ProjectUpdateOutbox" b ON b."stageId"=s.id JOIN public."ProjectUpdateIssuanceGate" g ON g."customerId"=i."customerId"
      WHERE i."customerId"=$1::uuid AND i."projectId"=$2::uuid AND i.locator IN ($3::uuid,$4::uuid)`,
      f.customerId, f.projectId, f.expired.locator, f.live.locator);
    expect(peers).toHaveLength(2);
    for (const row of peers) {
      expect(row).toMatchObject({ recipientSubject: f.owner.subject, issuanceEpoch: f.configuration.issuanceEpoch,
        gateEpoch: f.configuration.issuanceEpoch, gateEnabled: true, recipientRole: "OWNER", engagementState: "ACTIVE",
        obligationState: "OPEN", outboxState: "CAPTURED", contentState: "PRESENT", dependencies: [] });
      expect(row.generation).toBe(row.currentGeneration); expect(row.policyRevision).toBe(row.currentPolicy);
      expect(row.purgeAfter.getTime()).toBeGreaterThan(row.now.getTime());
      if (row.locator === f.expired.locator) { expect(row.kind).toBe("REQUEST"); expect(row.expiresAt.getTime()).toBeLessThan(row.now.getTime()); }
      else { expect(row.kind).toBe("REMINDER"); expect(row.expiresAt.getTime()).toBeGreaterThan(row.now.getTime()); }
    }
    const live = await call(f.live.locator, false); expect(live.status).toBe(200);
    const liveView = JSON.parse(live.body); expect(liveView.requestId).toBe(f.live.requestId);
    const baseline = await snapshot();
    const get = await call(f.expired.locator, false), post = await call(f.expired.locator, true);
    expect(get.status).toBe(404); expect(post.status).toBe(404); expect(post.body).toBe(get.body);
    for (const value of [f.projectId, f.expired.requestId, f.expired.locator, f.expired.body, liveView.project.name, liveView.project.code, f.owner.subject, canary]) {
      expect(get.body).not.toContain(value); expect(post.body).not.toContain(value);
    }
    expect(await snapshot()).toEqual(baseline);
  } finally { await app.close(); }
}, 60000);

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { seedCanonicalHistory } from "./canonical-projects.mjs";
import { runWithCleanup, drainAndClose } from "./fixture-cleanup.mjs";

export async function reserveStateBindingBirthFixture(
  owner,
  connection,
  customerId,
  existingProjectId,
  prefix,
) {
  const canonical = await seedCanonicalHistory(
    owner,
    connection,
    customerId,
    existingProjectId,
    prefix,
  );
  const targets = (
    await owner.query(
      'SELECT "milestoneId", "workItemId" FROM "RequiredWorkItem" WHERE "customerId"=$1 AND "projectId"=$2',
      [customerId, canonical.projectId],
    )
  ).rows;
  assert.equal(targets.length, 1);
  const subject = "binding-guard-" + randomUUID();
  await owner.query(
    'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'project\',$4,\'pmo_admin\')',
    [randomUUID(), customerId, subject, canonical.projectId],
  );
  return { customerId, projectId: canonical.projectId, subject, ...targets[0] };
}

// FR-EVD-004/012: exercise birth admission under the real runtime role, including
// the deferred COMMIT guard. All generated identities stay in this fixture.
export async function verifyStateBindingBirthGuards(
  pool,
  { customerId, projectId, subject, milestoneId, workItemId },
) {
  assert(
    ["isolated", "customer-composition"].includes(process.env.PDAA_ACCEPTANCE),
  );
  assert.match(
    process.env.PDAA_ACCEPTANCE_RUN_ID,
    /^pdaa-acceptance-\d+-[a-f0-9]{8}$/,
  );
  for (const id of [customerId, projectId, milestoneId, workItemId])
    assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(typeof subject, "string");
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM "CanonicalStateBinding" WHERE "customerId"=$1 AND "projectId"=$2',
        [customerId, projectId],
      )
    ).rows[0].n,
    0,
    "Binding guard fixture requires its explicitly reserved, unbound project",
  );
  const client = await pool.connect();
  const begin = async () => {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE pdaa_api");
    assert.equal(
      (await client.query("SELECT current_user AS role")).rows[0].role,
      "pdaa_api",
    );
  };
  const tables = new Set([
    "ProjectFact",
    "CanonicalStateBinding",
    "FactSource",
    "FactSourceAccess",
    "FactSourceReader",
    "FactEvidence",
    "ProjectFactVersion",
    "AuditEvent",
    "CanonicalStateBindingReceipt",
  ]);
  const insert = async (table, row) => {
    assert(tables.has(table));
    const columns = Object.keys(row);
    await client.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map((_, index) => "$" + (index + 1)).join(",")})`,
      Object.values(row),
    );
  };
  const assemble = async (mode, targetKind, targetId) => {
    const ids = Object.fromEntries(
      [
        "bindingId",
        "factId",
        "sourceId",
        "evidenceId",
        "versionId",
        "auditEventId",
        "receiptId",
      ].map((key) => [key, randomUUID()]),
    );
    const factType = "canonical.state." + randomUUID().replaceAll("-", "");
    const createdAt = (
      await client.query(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0].now;
    const scope = { customerId, projectId, factId: ids.factId };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          projectId,
          targetKind,
          targetId,
          initialState: "OPEN",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          validUntil: "2027-09-01T00:00:00.000Z",
          originalStatement: "Synthetic binding birth control",
        }),
      )
      .digest("hex");
    await insert("ProjectFact", {
      id: ids.factId,
      customerId,
      projectId,
      factType,
      bindingBirthId: ids.bindingId,
      createdAt,
    });
    await insert("CanonicalStateBinding", {
      id: ids.bindingId,
      customerId,
      projectId,
      targetKind,
      milestoneId: targetKind === "MILESTONE" ? targetId : null,
      workItemId: targetKind === "WORK_ITEM" ? targetId : null,
      field: "state",
      factId: ids.factId,
      factType,
      createdBy: subject,
      createdAt,
    });
    await insert("FactSource", {
      ...scope,
      id: ids.sourceId,
      providedBy: subject,
    });
    await insert("FactSourceAccess", {
      ...scope,
      sourceId: ids.sourceId,
      state: "AVAILABLE",
    });
    await insert("FactSourceReader", {
      ...scope,
      sourceId: ids.sourceId,
      subject,
    });
    await insert("FactEvidence", {
      ...scope,
      id: ids.evidenceId,
      sourceId: ids.sourceId,
      providedBy: subject,
      observedAt: createdAt,
      originalStatement: "Synthetic binding birth control",
    });
    await insert("ProjectFactVersion", {
      ...scope,
      id: ids.versionId,
      sourceId: ids.sourceId,
      evidenceId: ids.evidenceId,
      revision: 1,
      value: { type: "text", value: "OPEN" },
      effectiveAt: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
    });
    await insert("AuditEvent", {
      id: ids.auditEventId,
      customerId,
      actor: subject,
      event: "fact.binding.created",
      correlationId: "state-binding-birth-probe",
      occurredAt: createdAt,
      detail: {
        projectId,
        bindingId: mode === "altered-receipt" ? randomUUID() : ids.bindingId,
        factId: ids.factId,
        versionId: ids.versionId,
        evidenceId: ids.evidenceId,
      },
    });
    if (mode !== "missing-receipt")
      await insert("CanonicalStateBindingReceipt", {
        id: ids.receiptId,
        ...scope,
        subject,
        idempotencyKey: randomUUID(),
        requestHash,
        bindingId: ids.bindingId,
        sourceId: ids.sourceId,
        evidenceId: ids.evidenceId,
        versionId: ids.versionId,
        initialSourceAccessRevision: 2,
        initialSourceAccessState: "AVAILABLE",
        initialReaderSubject: subject,
        auditEventId: ids.auditEventId,
      });
    const state = (
      await client.query(
        `SELECT b.sealed, public.valid_canonical_state_binding(b.id) AS valid,
        f.revision, a.revision AS "accessRevision", a.state,
        (SELECT array_agg(subject ORDER BY subject) FROM "FactSourceReader" WHERE "sourceId"=$2) AS readers,
        (SELECT count(*)::int FROM "CanonicalStateBindingReceipt" WHERE "bindingId"=b.id) AS receipts
       FROM "CanonicalStateBinding" b JOIN "ProjectFact" f ON f.id=b."factId"
       JOIN "FactSourceAccess" a ON a."sourceId"=$2 WHERE b.id=$1`,
        [ids.bindingId, ids.sourceId],
      )
    ).rows[0];
    assert.deepEqual(state, {
      sealed: false,
      valid: ["valid", "unsealed"].includes(mode),
      revision: 1,
      accessRevision: 2,
      state: "AVAILABLE",
      readers: [subject],
      receipts: mode === "missing-receipt" ? 0 : 1,
    });
    return ids;
  };
  const seal = (ids) =>
    client.query('UPDATE "CanonicalStateBinding" SET sealed=true WHERE id=$1', [
      ids.bindingId,
    ]);
  const absent = async (ids) => {
    for (const [table, column, id] of [
      ["CanonicalStateBinding", "id", ids.bindingId],
      ["ProjectFact", "id", ids.factId],
      ["FactSource", "id", ids.sourceId],
      ["FactSourceAccess", "sourceId", ids.sourceId],
      ["FactSourceReader", "sourceId", ids.sourceId],
      ["FactEvidence", "id", ids.evidenceId],
      ["ProjectFactVersion", "id", ids.versionId],
      ["AuditEvent", "id", ids.auditEventId],
      ["CanonicalStateBindingReceipt", "id", ids.receiptId],
    ])
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}"=$1`,
            [id],
          )
        ).rows[0].n,
        0,
      );
  };
  return runWithCleanup(
    async () => {
      await begin();
      const control = await assemble("valid", "MILESTONE", milestoneId);
      await seal(control);
      await client.query("COMMIT");
      assert.equal(
        (
          await pool.query(
            'SELECT sealed AND public.valid_canonical_state_binding(id) AS valid FROM "CanonicalStateBinding" WHERE id=$1',
            [control.bindingId],
          )
        ).rows[0].valid,
        true,
      );
      await begin();
      const unsealed = await assemble("unsealed", "WORK_ITEM", workItemId);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error) =>
          error.code === "P0001" &&
          error.message === "Unsealed state binding cannot commit",
      );
      await client.query("ROLLBACK");
      await absent(unsealed);
      for (const mode of ["missing-receipt", "altered-receipt"]) {
        await begin();
        const ids = await assemble(mode, "WORK_ITEM", workItemId);
        await assert.rejects(
          () => seal(ids),
          (error) =>
            error.code === "P0001" &&
            error.message === "Invalid state binding seal",
        );
        await client.query("ROLLBACK");
        await absent(ids);
      }
      return {
        executedAs: "pdaa_api",
        projectId,
        bindingId: control.bindingId,
        completeBirthCommitPassed: true,
        unsealedCommitDenied: true,
        missingReceiptSealDenied: true,
        alteredReceiptSealDenied: true,
        noPartialBirthRows: true,
      };
    },
    async () => {
      let rollbackFailure;
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        rollbackFailure = error;
      }
      await drainAndClose(
        [],
        [() => client.release(rollbackFailure)],
        rollbackFailure ? [rollbackFailure] : [],
      );
    },
  );
}

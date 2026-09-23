import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { applyBusinessTableGrants } from "../packages/operations/src/business-grants.js";

// NFR-SEC-001, TR-STACK-005, FR-EVD-012: a no-ACL restore must rebuild the
// reviewed finite function boundary. These contracts complement real role probes.
type GrantClient = Parameters<typeof applyBusinessTableGrants>[0];
function splitFunctionSignatures(value: string): string[] {
  const signatures: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")") depth--;
    else if (value[index] === "," && depth === 0) {
      signatures.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  signatures.push(value.slice(start).trim());
  return signatures;
}
function client(name: string, rolsuper = false, invalid = 0) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ name, rolsuper }] })
      .mockResolvedValueOnce({ rows: [{ n: invalid }] })
      .mockResolvedValue({ rows: [] }),
  };
}

it("rebuilds finite released and ingestion function boundaries before granting only the approved API validators", async () => {
  const owner = client("pdaa_migrate");
  await applyBusinessTableGrants(owner as unknown as GrantClient);
  const sql = owner.query.mock.calls[2]![0] as string;
  const migration = readFileSync(
    new URL(
      "../packages/data/prisma/migrations/202609120001_milestone_consistency_persistence/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const signatures = [
    ...migration.matchAll(/REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC;/g),
  ]
    .flatMap((match) => splitFunctionSignatures(match[1]!))
    .sort();
  expect(signatures).toHaveLength(14);
  const stage3 = readFileSync(
    new URL(
      "../packages/data/prisma/migrations/202609120002_milestone_reconciliation_requests/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const newSignatures = [
    ...stage3.matchAll(/REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC;/g),
  ]
    .flatMap((match) => splitFunctionSignatures(match[1]!))
    .sort();
  expect(newSignatures).toHaveLength(7);
  const scalar = readFileSync(
    new URL(
      "../packages/data/prisma/migrations/202609130001_scalar_reconciliation_requests/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const scalarSignatures = [
    ...scalar.matchAll(/REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC;/g),
  ]
    .flatMap((match) => splitFunctionSignatures(match[1]!))
    .sort();
  expect(scalarSignatures).toHaveLength(8);
  const revoked = [
    ...sql.matchAll(
      /REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;/g,
    ),
  ];
  const ingestionSignatures = [
    "public.valid_ingestion_proposals(jsonb)",
    "public.valid_ingestion_projection_content(uuid,jsonb)",
    "public.valid_ingestion_receipt(uuid)",
  ];
  expect(revoked).toHaveLength(4);
  expect(
    revoked
      .flatMap((match) => splitFunctionSignatures(match[1]!))
      .sort(),
  ).toEqual(
    [...signatures, ...newSignatures, ...scalarSignatures, ...ingestionSignatures].sort(),
  );
  const granted = [
    ...sql.matchAll(/GRANT EXECUTE ON FUNCTION ([^;]+) TO pdaa_api;/g),
  ];
  expect(granted).toHaveLength(4);
  expect(granted.flatMap((match) => splitFunctionSignatures(match[1]!)).sort()).toEqual(
    [
      "public.valid_canonical_state_binding(uuid)",
      "public.valid_milestone_consistency_assessment(uuid)",
      "public.valid_milestone_reconciliation_assignment(uuid)",
      "public.valid_milestone_reconciliation_check(uuid)",
      "public.valid_milestone_reconciliation_request(uuid)",
      "public.scalar_reconciliation_identity(uuid)",
      "public.valid_scalar_reconciliation_assignment(uuid)",
      "public.valid_scalar_reconciliation_check(uuid)",
      "public.valid_scalar_reconciliation_request(uuid)",
      ...ingestionSignatures,
    ].sort(),
  );
  for (const grant of granted)
    for (const signature of splitFunctionSignatures(grant[1]!)) {
      const revoke = revoked.find((match) =>
        splitFunctionSignatures(match[1]!).includes(signature),
      );
      expect(revoke).toBeDefined();
      expect(revoke!.index).toBeLessThan(grant.index!);
    }
  expect([
    ...sql.matchAll(/(?:GRANT|REVOKE) [^;]*ON FUNCTION [^;]+;/g),
  ]).toHaveLength(8);
});

it("removes independent column ACL drift before the finite least-privilege grants", async () => {
  const owner = client("pdaa_migrate");
  await applyBusinessTableGrants(owner as unknown as GrantClient);
  const sql = owner.query.mock.calls[2]![0] as string;
  // PostgreSQL table REVOKE also removes corresponding column privileges.
  // https://www.postgresql.org/docs/17/sql-revoke.html
  expect(sql).toContain(
    "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pdaa_api,pdaa_worker,pdaa_backup",
  );
  expect(sql.indexOf("REVOKE ALL ON ALL TABLES")).toBeLessThan(
    sql.indexOf("GRANT SELECT,INSERT,UPDATE,DELETE"),
  );
  expect(sql).toContain(
    'GRANT UPDATE (sealed) ON "MilestoneReconciliationRequest" TO pdaa_api',
  );
  expect(sql).not.toContain('GRANT UPDATE ("reconciliationCheckId")');
  expect(sql).toContain(
    'GRANT UPDATE (sealed) ON "ScalarReconciliationRequest" TO pdaa_api',
  );
  expect(sql).not.toContain('GRANT UPDATE ("scalarReconciliationCheckId")');
});

it("also rebuilds function permissions for the authorized restore superuser", async () => {
  const owner = client("fixture_admin", true);
  await applyBusinessTableGrants(owner as unknown as GrantClient);
  expect(owner.query.mock.calls[2]![0]).toContain(
    "FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;",
  );
});

it("does not report an unauthorized principal's no-op grants as restored ACLs", async () => {
  const denied = client("pdaa_backup");
  await expect(
    applyBusinessTableGrants(denied as unknown as GrantClient),
  ).rejects.toThrow("Migration owner required");
  expect(denied.query).toHaveBeenCalledTimes(1);
});

it("refuses ACL reconstruction while any business table has the wrong owner", async () => {
  const denied = client("fixture_admin", true, 1);
  await expect(
    applyBusinessTableGrants(denied as unknown as GrantClient),
  ).rejects.toThrow("Unexpected business table owner");
  expect(denied.query).toHaveBeenCalledTimes(2);
});


import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { applyBusinessTableGrants } from "../packages/operations/src/business-grants.js";

// NFR-SEC-001, TR-STACK-005, FR-EVD-012: a no-ACL restore must rebuild the
// reviewed finite function boundary. These contracts complement real role probes.
type GrantClient = Parameters<typeof applyBusinessTableGrants>[0];
function client(name: string, rolsuper = false, invalid = 0) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ name, rolsuper }] })
      .mockResolvedValueOnce({ rows: [{ n: invalid }] })
      .mockResolvedValue({ rows: [] }),
  };
}

it("rebuilds every migration-5 function revocation before granting only the two API predicates", async () => {
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
    .flatMap((match) => match[1]!.split(",").map((part) => part.trim()))
    .sort();
  expect(signatures).toHaveLength(14);
  const revoked = sql.match(
    /REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;/,
  );
  expect(revoked).not.toBeNull();
  expect(
    revoked![1]!
      .split(",")
      .map((part) => part.trim())
      .sort(),
  ).toEqual(signatures);
  const granted = sql.match(/GRANT EXECUTE ON FUNCTION ([^;]+) TO pdaa_api;/);
  expect(granted?.[1]?.split(",")).toEqual([
    "public.valid_canonical_state_binding(uuid)",
    "public.valid_milestone_consistency_assessment(uuid)",
  ]);
  expect(sql.indexOf(revoked![0])).toBeLessThan(sql.indexOf(granted![0]));
  expect([
    ...sql.matchAll(/(?:GRANT|REVOKE) [^;]*ON FUNCTION [^;]+;/g),
  ]).toHaveLength(2);
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

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPriorSixBusinessGrants } from "../scripts/acceptance/prior-six-business-grants.mjs";

// NFR-SEC-001, FR-EVD-007/012: never apply current ACLs to an older fixture.
beforeEach(() => vi.stubEnv("PDAA_ACCEPTANCE", "isolated"));
afterEach(() => vi.unstubAllEnvs());
function owner(prefix = { completed: 6, reconciliation: true, scalar: false }) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ name: "pdaa_migrate", rolsuper: false }],
      })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [prefix] })
      .mockResolvedValue({ rows: [] }),
  };
}
it("keeps the frozen v6 table and function boundary without forward ownership", async () => {
  const db = owner();
  await applyPriorSixBusinessGrants(db);
  expect(db.query).toHaveBeenCalledTimes(4);
  const sql = db.query.mock.calls[3]![0] as string;
  expect(sql).not.toMatch(
    /ScalarReconciliation|scalar_reconciliation|scalarReconciliationCheckId|CONNECT/,
  );
  expect(sql).toContain(
    'GRANT UPDATE (sealed) ON "MilestoneReconciliationRequest" TO pdaa_api',
  );
  const grants = [
    ...sql.matchAll(/GRANT EXECUTE ON FUNCTION ([^;]+) TO pdaa_api;/g),
  ];
  expect(grants.flatMap((match) => match[1]!.split(",")).sort()).toEqual([
    "public.valid_canonical_state_binding(uuid)",
    "public.valid_milestone_consistency_assessment(uuid)",
    "public.valid_milestone_reconciliation_assignment(uuid)",
    "public.valid_milestone_reconciliation_check(uuid)",
    "public.valid_milestone_reconciliation_request(uuid)",
  ]);
  expect([
    ...sql.matchAll(
      /REVOKE ALL ON FUNCTION [^;]+ FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;/g,
    ),
  ]).toHaveLength(2);
});
it.each([
  { completed: 5, reconciliation: true, scalar: false },
  { completed: 7, reconciliation: true, scalar: true },
  { completed: 6, reconciliation: false, scalar: false },
  { completed: 6, reconciliation: true, scalar: true },
])("rejects incompatible schema before changing ACLs: %j", async (prefix) => {
  const db = owner(prefix);
  await expect(applyPriorSixBusinessGrants(db)).rejects.toThrow();
  expect(db.query).toHaveBeenCalledTimes(3);
});
it("does not access the database outside isolated acceptance", async () => {
  vi.stubEnv("PDAA_ACCEPTANCE", "production");
  const db = owner();
  await expect(applyPriorSixBusinessGrants(db)).rejects.toThrow();
  expect(db.query).not.toHaveBeenCalled();
});

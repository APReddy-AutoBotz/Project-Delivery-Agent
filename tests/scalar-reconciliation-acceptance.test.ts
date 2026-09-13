import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), immutable: vi.fn() }));
vi.mock("../scripts/acceptance/milestone-reconciliation.mjs", () => ({
  reconciliationAcceptanceGuard: mocks.guard,
}));
vi.mock("../scripts/acceptance/immutable-history.mjs", () => ({
  verifyImmutableHistoryMutation: mocks.immutable,
}));
import {
  scalarReconciliationTables,
  scalarReconciliationProjection,
  verifyScalarReconciliationPrivileges,
  verifyScalarReconciliationIntegrity,
  verifyScalarReconciliationImmutable,
} from "../scripts/acceptance/scalar-reconciliation.mjs";
beforeEach(() => vi.resetAllMocks());
it("FR-EVD-007/012: projects all three full scalar row families", async () => {
  const pool = {
    query: vi.fn(async (sql: string) => ({ rows: [{ retained: sql }] })),
  };
  const result = await scalarReconciliationProjection(pool);
  expect(Object.keys(result)).toEqual(scalarReconciliationTables);
  for (const table of scalarReconciliationTables)
    expect(pool.query).toHaveBeenCalledWith(
      `SELECT * FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
    );
  expect(mocks.guard).toHaveBeenCalledOnce();
});
it("NFR-REL-001: refuses invalid or malformed restored integrity totals", async () => {
  for (const invalid of [1, "2", undefined, null, false, "", "invalid"])
    await expect(
      verifyScalarReconciliationIntegrity({
        query: async () => ({ rows: [{ invalid }] }),
      }),
    ).rejects.toThrow();
  const query = vi.fn(async () => ({ rows: [{ invalid: "0" }] }));
  expect(await verifyScalarReconciliationIntegrity({ query })).toBe(true);
  const sql = query.mock.calls[0]![0] as string;
  for (const name of [
    "valid_scalar_reconciliation_request",
    "valid_scalar_reconciliation_check",
    "valid_scalar_reconciliation_assignment",
    "scalarReconciliationCheckId",
  ])
    expect(sql).toContain(name);
});
it("NFR-REL-001: uses exact native guards for every scalar mutation family", async () => {
  const database = {};
  expect(await verifyScalarReconciliationImmutable(database)).toBe(true);
  expect(mocks.immutable.mock.calls).toEqual(
    scalarReconciliationTables.flatMap((table) =>
      ["UPDATE", "DELETE", "TRUNCATE"].map((operation) => [
        database,
        table,
        operation,
      ]),
    ),
  );
});
function privilegeClient(drift = false) {
  return {
    query: vi.fn(async (sql: string, args: string[]) => {
      if (sql.includes("pg_get_userbyid"))
        return { rows: [{ owner: "pdaa_migrate" }] };
      if (sql.includes("information_schema"))
        return {
          rows: [{ column_name: "sealed" }, { column_name: "customerId" }],
        };
      const [role, object, third, fourth] = args;
      const privilege = fourth ?? third;
      const grantOption = privilege.includes("WITH GRANT OPTION");
      let allowed = false;
      if (!grantOption) {
        if (sql.includes("has_function_privilege"))
          allowed =
            role === "pdaa_api" &&
            (object.startsWith("public.valid_") ||
              object.startsWith("public.scalar_reconciliation_identity"));
        else
          allowed =
            (role === "pdaa_backup" && privilege === "SELECT") ||
            (role === "pdaa_api" &&
              (["SELECT", "INSERT"].includes(privilege) ||
                (Boolean(fourth) &&
                  object === '"ScalarReconciliationRequest"' &&
                  third === "sealed" &&
                  privilege === "UPDATE")));
      }
      if (
        drift &&
        role === "pdaa_worker" &&
        sql.includes("has_function_privilege")
      )
        allowed = true;
      return { rows: [{ allowed }] };
    }),
  };
}
it("NFR-SEC-001: checks finite table, column and function grants without SQL mutations", async () => {
  const owner = privilegeClient();
  expect(await verifyScalarReconciliationPrivileges(owner)).toBe(true);
  expect(
    owner.query.mock.calls.every(([sql]) => sql.startsWith("SELECT")),
  ).toBe(true);
  expect(
    owner.query.mock.calls.some(([, args]) =>
      args.includes("EXECUTE WITH GRANT OPTION"),
    ),
  ).toBe(true);
  await expect(
    verifyScalarReconciliationPrivileges(privilegeClient(true)),
  ).rejects.toThrow();
});

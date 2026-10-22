// EXEC-019 / NFR-SEC-001, NFR-REL-001: complete batched recovery probes.
import { describe, expect, it } from "vitest";
import { verifyReassessmentPrivileges, verifyRestoredReassessments } from "../scripts/acceptance/ingestion-reassessment.mjs";

type Row = Record<string, unknown>;
type Kind = "table" | "column" | "function";
const columns = ["id", "state", "customerId"];
function fixture(mutate?: (kind: Kind, rows: Row[]) => void) {
  let queries = 0;
  const pool = { query: async (sql: string, params?: string[][]) => {
    queries++;
    if (sql.includes("pg_get_userbyid")) return { rows: [{ owner: "pdaa_migrate" }] };
    if (sql.includes("information_schema.columns")) return { rows: columns.map((column_name) => ({ column_name })) };
    const [roles, names, privileges] = params!;
    expect(roles).toEqual(["pdaa_api", "pdaa_worker", "pdaa_backup"]);
    let kind: Kind;
    let rows: Row[];
    if (sql.includes("has_table_privilege")) {
      kind = "table";
      expect(names).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]);
      rows = roles!.flatMap((role_name) => names!.map((privilege) => ({ role_name, privilege,
        allowed: role_name === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege)
          || role_name === "pdaa_backup" && privilege === "SELECT", grantable: false })));
    } else if (sql.includes("has_column_privilege")) {
      kind = "column";
      expect(names).toEqual(["id", "state", "customerId"]);
      expect(privileges).toEqual(["SELECT", "INSERT", "UPDATE", "REFERENCES"]);
      rows = roles!.flatMap((role_name) => names!.flatMap((column_name) => privileges!.map((privilege) => ({ role_name, column_name, privilege,
        allowed: role_name === "pdaa_api" && (["SELECT", "INSERT"].includes(privilege) || privilege === "UPDATE" && column_name === "state")
          || role_name === "pdaa_backup" && privilege === "SELECT" }))));
    } else {
      expect(sql).toContain("has_function_privilege");
      kind = "function";
      expect(names).toEqual(["guard_ingestion_project_reassessment()", "require_ingestion_reassessment_complete()",
        "lock_ingestion_reassessment_preview()", "reject_ingestion_reassessment_history()",
        'valid_ingestion_reassessment_row(public."IngestionProjectReassessment")', "valid_ingestion_project_reassessment(uuid)"]);
      rows = roles!.flatMap((role_name) => names!.map((function_name) => ({ role_name, function_name,
        allowed: role_name === "pdaa_api" && [
          'valid_ingestion_reassessment_row(public."IngestionProjectReassessment")',
          "valid_ingestion_project_reassessment(uuid)",
        ].includes(function_name) })));
    }
    mutate?.(kind, rows);
    return { rows };
  } };
  return { pool, queries: () => queries };
}

describe("complete finite recovery privilege matrices", () => {
  it("checks all original table, column and function expectations in five queries", async () => {
    const f = fixture();
    expect(await verifyReassessmentPrivileges(f.pool)).toBe(true);
    expect(f.queries()).toBe(5);
  });
  for (const kind of ["table", "column", "function"] as const) {
    it.each(["missing", "duplicate", "substituted", "extra", "null", "wrong"])("rejects " + kind + " matrix %s", async (change) => {
      const f = fixture((current, rows) => {
        if (current !== kind) return;
        if (change === "missing") rows.pop();
        if (change === "duplicate") rows[1] = { ...rows[0] };
        if (change === "substituted") rows[0]!.role_name = "unexpected_role";
        if (change === "extra") rows.push({ ...rows[0] });
        if (change === "null") rows[0]!.allowed = null;
        if (change === "wrong") rows[0]!.allowed = !rows[0]!.allowed;
      });
      await expect(verifyReassessmentPrivileges(f.pool)).rejects.toThrow();
    });
  }
  it("continues to deny table grant options", async () => {
    const f = fixture((kind, rows) => { if (kind === "table") rows[0]!.grantable = true; });
    await expect(verifyReassessmentPrivileges(f.pool)).rejects.toThrow();
  });
  it.each(["empty", "duplicate", "wrong owner"])("rejects %s metadata", async (change) => {
    const f = fixture();
    const query = f.pool.query;
    f.pool.query = async (sql, params) => {
      if (change === "wrong owner" && sql.includes("pg_get_userbyid")) return { rows: [{ owner: "pdaa_api" }] };
      if (sql.includes("information_schema.columns")) return { rows: change === "empty" ? [] : [{ column_name: "id" }, { column_name: "id" }] };
      return query(sql, params);
    };
    await expect(verifyReassessmentPrivileges(f.pool)).rejects.toThrow();
  });
});

describe("recovery mutation denial client affinity", () => {
  it.each(["denied", "wrong role", "write allowed", "rollback fails"])("pins and releases one client when %s", async (mode) => {
    const f = fixture(), commands: string[] = [];
    const saved = { projectId: "project", causes: [{ id: "completed", state: "COMPLETED" }], scheduler: [] };
    const pool = {
      query: async (sql: string, params?: string[][]) => {
        if (sql.includes('SELECT * FROM public."IngestionProjectReassessment"')) return { rows: saved.causes };
        if (sql.includes('SELECT * FROM public."ProjectUpdatePolicy"')) return { rows: saved.scheduler };
        if (sql.includes("count(*)::int")) return { rows: [{ n: 0 }] };
        return f.pool.query(sql, params);
      },
      connect: async () => ({ query: async (sql: string) => {
        commands.push(sql);
        if (sql === "SELECT current_user AS role") return { rows: [{ role: mode === "wrong role" ? "pdaa_migrate" : "pdaa_api" }] };
        if (sql.startsWith("UPDATE") && mode !== "write allowed") throw new Error("Denied fixture mutation");
        if (sql === "ROLLBACK" && mode === "rollback fails") throw new Error("Rollback fixture failure");
        return { rows: [] };
      }, release: () => { commands.push("RELEASE"); } }),
    };
    if (mode === "denied") expect(await verifyRestoredReassessments(pool, saved)).toMatchObject({ immutableCompletionDenied: true });
    else await expect(verifyRestoredReassessments(pool, saved)).rejects.toThrow();
    expect(commands.slice(0, 3)).toEqual(["BEGIN", "SET LOCAL ROLE pdaa_api", "SELECT current_user AS role"]);
    expect(commands.slice(-2)).toEqual(["ROLLBACK", "RELEASE"]);
    expect(commands.filter((command) => command.startsWith("UPDATE"))).toHaveLength(mode === "wrong role" ? 0 : 1);
  });
});

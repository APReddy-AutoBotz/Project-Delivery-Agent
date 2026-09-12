import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyStateBindingBirthGuards } from "../scripts/acceptance/state-binding-birth.mjs";

beforeEach(() => {
  vi.stubEnv("PDAA_ACCEPTANCE", "isolated");
  vi.stubEnv(
    "PDAA_ACCEPTANCE_RUN_ID",
    "pdaa-acceptance-1789190000000-deadbeef",
  );
});
afterEach(() => vi.unstubAllEnvs());
const descriptor = {
  customerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  milestoneId: "33333333-3333-4333-8333-333333333333",
  workItemId: "44444444-4444-4444-8444-444444444444",
  subject: "binding-guard-contract",
};
it("FR-EVD-004: refuses a previously consumed binding probe fixture", async () => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ n: 1 }] }),
    connect: vi.fn(),
  };
  await expect(verifyStateBindingBirthGuards(pool, descriptor)).rejects.toThrow(
    "reserved, unbound project",
  );
  expect(pool.connect).not.toHaveBeenCalled();
});
it("NFR-SEC-001: refuses birth writes if SET ROLE did not establish pdaa_api", async () => {
  const client = {
    query: vi.fn(async (sql: string) => ({
      rows:
        sql === "SELECT current_user AS role"
          ? [{ role: "fixture_admin" }]
          : [],
    })),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ n: 0 }] }),
    connect: vi.fn().mockResolvedValue(client),
  };
  await expect(verifyStateBindingBirthGuards(pool, descriptor)).rejects.toThrow(
    "pdaa_api",
  );
  expect(client.query.mock.calls.some(([sql]) => /^INSERT\b/.test(sql))).toBe(
    false,
  );
  expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalledOnce();
});

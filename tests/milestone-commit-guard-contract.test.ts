import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyMilestonePersistenceCommitGuards } from "../scripts/acceptance/milestone-persistence.mjs";

// FR-EVD-004/012: these fixture-contract tests complement real SQL probes;
// they are not evidence that a migration or database invariant has passed.
const assessmentId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.stubEnv("PDAA_ACCEPTANCE", "isolated");
  vi.stubEnv(
    "PDAA_ACCEPTANCE_RUN_ID",
    "pdaa-acceptance-1789190000000-deadbeef",
  );
});
afterEach(() => vi.unstubAllEnvs());

it("refuses proof writes unless the transaction's effective role is pdaa_api", async () => {
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
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: assessmentId }] })
      .mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(client),
  };
  await expect(
    verifyMilestonePersistenceCommitGuards(pool, { assessmentId }),
  ).rejects.toThrow(/pdaa_api/);
  expect(client.query).toHaveBeenCalledWith("SET LOCAL ROLE pdaa_api");
  expect(client.query.mock.calls.some(([sql]) => /^INSERT\b/.test(sql))).toBe(
    false,
  );
  expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalledOnce();
});

it("does not substitute a different positive proof when the pinned assessment is unavailable", async () => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
  };
  await expect(
    verifyMilestonePersistenceCommitGuards(pool, { assessmentId }),
  ).rejects.toThrow("A positive cross-proof fixture is required");
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining("WHERE id=$1 AND sealed"),
    [assessmentId],
  );
  expect(pool.connect).not.toHaveBeenCalled();
});

it("requires an explicit source identity before querying any proof", async () => {
  const pool = { query: vi.fn(), connect: vi.fn() };
  await expect(
    verifyMilestonePersistenceCommitGuards(pool, {}),
  ).rejects.toThrow();
  expect(pool.query).not.toHaveBeenCalled();
  expect(pool.connect).not.toHaveBeenCalled();
});

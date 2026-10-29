import { afterEach, expect, it, vi } from "vitest";
import { observeBlockerAgeAdviceInTransaction } from "../packages/data/src/blocker-age-advice.js";
import * as assessment from "../packages/data/src/blocker-age-assessment.js";
import { DatabaseHealthAssessmentRepository } from "../packages/data/src/health-assessment.js";

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const actor = { customerId: id(1), subject: "synthetic-pm", roles: ["project_manager"] };
const projectId = id(2), raidId = id(3), asOf = new Date("2026-10-21T12:00:00.000Z");
const threshold = { minimumBlockerAgeDays: 5, auditRetentionHours: 720, revision: 1, changedBy: "synthetic-admin", changedAt: asOf };
const rawProof = (value: boolean | string, number: number) => ({ status: "RESOLVED" as const, value,
  factId: id(number), versionIds: [id(number + 300)], evidenceIds: [id(number + 400)] });
const authority = (factType: string, number: number) => ({ factId: id(number), factType, factRevision: 1,
  policyId: id(number + 100), policyThroughRevision: 2, policyRevisionId: id(number + 200), policyRevision: 2 });
function fixture() {
  const inventory = rawProof(true, 10), classification = rawProof(true, 11), openedAt = rawProof("2026-10-16", 12);
  const authorities = [authority("project.open_blocker_inventory_complete", 10),
    authority(`raid_item.${raidId}.blocks_delivery`, 11), authority(`raid_item.${raidId}.opened_at`, 12)];
  const input = { coverage: "COMPLETE" as const,
    gates: { canonicalSealed: true, raidSnapshotBounded: true, inventoryAttested: true, thresholdConfigured: true, sourceHistoryComplete: true },
    threshold: { minimumBlockerAgeDays: 5, revision: 1 }, inventoryCompleteness: inventory,
    candidates: [{ raidItemId: raidId, key: "ISSUE-1", state: "OPEN" as const, classification, openedAt,
      outcome: "AGED" as const, age: 5, thresholdExceeded: true }], authorityRevisions: authorities,
    dependencies: [{ factId: id(10), sourceId: id(510) }, { factId: id(11), sourceId: id(511) }, { factId: id(12), sourceId: id(512) }] };
  const built = { asOf, coverage: "COMPLETE" as const, input, result: { coverage: "COMPLETE", asOf: asOf.toISOString(),
    candidateCount: 1, noOpenBlockers: false }, newConflicts: [] };
  const build = vi.spyOn(assessment, "buildBlockerAgeAssessmentInTransaction").mockResolvedValue(built as never);
  const readable = vi.spyOn(DatabaseHealthAssessmentRepository.prototype, "sourcesReadableInTransaction").mockResolvedValue(true);
  const tx = { $queryRawUnsafe: vi.fn(async (sql: string, customer: string, project: string, payload: string, subject: string, time: Date) => {
    expect(sql).toContain("jsonb_to_recordset"); expect(customer).toBe(actor.customerId); expect(project).toBe(projectId);
    expect(subject).toBe(actor.subject); expect(time).toEqual(asOf);
    return (JSON.parse(payload) as { factId: string; factType: string; factRevision: number; policyId: string;
      policyRevisionId: string; policyRevision: number; versionIds: string[]; evidenceIds: string[]; expectedValue: boolean | string }[])
      .flatMap((row, index) => row.versionIds.map((versionId) => ({ factId: row.factId, factType: row.factType,
        factRevision: row.factRevision, policyId: row.policyId, policyRevisionId: row.policyRevisionId, policyRevision: row.policyRevision,
        versionId, evidenceId: row.evidenceIds[0], sourceId: id(510 + index), accessRevision: 1,
        sourceType: "human_statement", provenance: "HUMAN_CONFIRMED",
        value: { type: typeof row.expectedValue === "boolean" ? "boolean" : "date", value: row.expectedValue } })));
  }) };
  const read = () => observeBlockerAgeAdviceInTransaction(tx as never, {} as never, actor, projectId, "project_manager", threshold, true);
  return { built, build, readable, tx, read };
}
afterEach(() => vi.restoreAllMocks());

it("projects verified proof tuples only after the wrapped current-reader check", async () => {
  const f = fixture(), result = await f.read();
  expect(f.build.mock.calls[0]?.at(-1)).toEqual({ strictPreparationErrors: true });
  expect(f.readable).toHaveBeenCalledWith(f.tx, actor, projectId, { blockerAge: f.built.input });
  expect(result).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: false,
    items: [{ key: "ISSUE-1", ageDays: 5, classification: { supports: [{ sourceId: id(511) }] },
      openedAtProof: { validity: "UNTIL_SUPERSEDED", supports: [{ sourceId: id(512) }] } }] });
});
it("withholds a restricted dependency or new conflict without querying proof IDs", async () => {
  const f = fixture(); f.readable.mockResolvedValueOnce(false);
  const restricted = await f.read(); expect(restricted).toMatchObject({ coverage: "UNASSESSABLE", items: [], inventory: null });
  expect(JSON.stringify(restricted)).not.toContain(id(510)); expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  f.build.mockResolvedValueOnce({ ...f.built, newConflicts: [{ id: id(999) }] } as never);
  expect(await f.read()).toMatchObject({ coverage: "UNASSESSABLE", items: [], inventory: null });
  expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
});
it("fails closed on over-limit input and malformed or mismatched proof tuples", async () => {
  const f = fixture();
  f.build.mockResolvedValueOnce({ ...f.built, coverage: "UNASSESSABLE", input: { reason: "RAID_SNAPSHOT_OVER_LIMIT" } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.build.mockResolvedValueOnce({ ...f.built, coverage: "UNASSESSABLE", input: { reason: "SOURCE_HISTORY_OVER_LIMIT" } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  const query = f.tx.$queryRawUnsafe.getMockImplementation()!;
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => (await query(...args)).slice(1));
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => {
    const rows = await query(...args); rows[0]!.value = { type: "boolean", value: false }; return rows;
  });
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => {
    const rows = await query(...args); rows[1]!.sourceType = "jira"; return rows;
  });
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => {
    const rows = await query(...args); rows[0]!.evidenceId = id(999); return rows;
  });
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => {
    const rows = await query(...args); rows[0]!.policyRevisionId = id(999); return rows;
  });
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => {
    const rows = await query(...args); rows[0]!.accessRevision = 0; return rows;
  });
  await expect(f.read()).rejects.toThrow();
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => {
    const rows = await query(...args); rows.push({ ...rows[0]! }); return rows;
  });
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
});
it("allows a proven aged case with partial coverage but never a partial clear claim", async () => {
  const f = fixture();
  const unknown = { ...f.built.input.candidates[0]!, raidItemId: id(4), key: "ISSUE-2",
    classification: { status: "UNKNOWN", value: null, factId: null, versionIds: [], evidenceIds: [] }, openedAt: null,
    outcome: "UNKNOWN_CLASSIFICATION", age: undefined, thresholdExceeded: undefined };
  const partial = { ...f.built, coverage: "PARTIAL", input: { ...f.built.input, coverage: "PARTIAL", candidates: [...f.built.input.candidates, unknown] },
    result: { ...f.built.result, coverage: "PARTIAL", candidateCount: 2, noOpenBlockers: null } };
  f.build.mockResolvedValueOnce(partial as never);
  expect(await f.read()).toMatchObject({ coverage: "PARTIAL", noOpenBlockers: null, items: [{ key: "ISSUE-1" }] });
  f.build.mockResolvedValueOnce({ ...partial, result: { ...partial.result, noOpenBlockers: true } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
});
it("distinguishes an attested empty inventory from an open blocker below threshold", async () => {
  const f = fixture();
  const empty = { ...f.built, input: { ...f.built.input, candidates: [] },
    result: { ...f.built.result, candidateCount: 0, noOpenBlockers: true } };
  f.build.mockResolvedValueOnce(empty as never);
  expect(await f.read()).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: true, items: [] });
  const below = { ...f.built, input: { ...f.built.input, candidates: [{ ...f.built.input.candidates[0]!,
    openedAt: { ...f.built.input.candidates[0]!.openedAt, value: "2026-10-17" },
    outcome: "WITHIN_THRESHOLD", age: 4, thresholdExceeded: false }] } };
  f.build.mockResolvedValueOnce(below as never);
  expect(await f.read()).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: false, items: [] });
  f.build.mockResolvedValueOnce({ ...f.built, result: { ...f.built.result, noOpenBlockers: true } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.build.mockResolvedValueOnce({ ...below, input: { ...below.input, candidates: [{ ...below.input.candidates[0]!,
    openedAt: { ...below.input.candidates[0]!.openedAt, value: "2026-10-16" } }] } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
});
it("binds the false classification proof before claiming no open blockers", async () => {
  const f = fixture();
  const excluded = { ...f.built, input: { ...f.built.input, candidates: [{ ...f.built.input.candidates[0]!,
    classification: rawProof(false, 11), openedAt: null, outcome: "EXCLUDED", age: undefined, thresholdExceeded: undefined }],
    dependencies: f.built.input.dependencies.slice(0, 2) }, result: { ...f.built.result, noOpenBlockers: true } };
  f.build.mockResolvedValueOnce(excluded as never);
  expect(await f.read()).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: true, items: [] });
  const invalid = { ...excluded, input: { ...excluded.input, candidates: [{ ...excluded.input.candidates[0]!,
    classification: { ...excluded.input.candidates[0]!.classification, factId: null, versionIds: [], evidenceIds: [] } }] } };
  f.build.mockResolvedValueOnce(invalid as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  const query = f.tx.$queryRawUnsafe.getMockImplementation()!;
  f.tx.$queryRawUnsafe.mockImplementationOnce(async (...args) => {
    const rows = await query(...args); rows[1]!.value = { type: "boolean", value: true }; return rows;
  });
  f.build.mockResolvedValueOnce(excluded as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
});
it("rejects missing or duplicate dependencies and genuinely checks a wrapped restricted dependency", async () => {
  const f = fixture();
  f.build.mockResolvedValueOnce({ ...f.built, input: { ...f.built.input, dependencies: [] } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  f.build.mockResolvedValueOnce({ ...f.built, input: { ...f.built.input,
    dependencies: [f.built.input.dependencies[0], f.built.input.dependencies[0]] } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  vi.restoreAllMocks();
  const tx = { $queryRawUnsafe: vi.fn(async () => []) };
  const health = new DatabaseHealthAssessmentRepository({} as never);
  expect(await health.sourcesReadableInTransaction(tx as never, actor, projectId, { blockerAge: f.built.input })).toBe(false);
});
it("withholds the facet through the real source check when a competing reader is missing", async () => {
  const f = fixture(); f.readable.mockRestore();
  f.built.input.dependencies.push({ factId: id(11), sourceId: id(599) });
  f.tx.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM public."FactSourceAccess"')) return f.built.input.dependencies.map((entry) => ({ ...entry, state: "AVAILABLE" }));
    if (sql.includes('FROM public."FactSourceReader"')) return f.built.input.dependencies.slice(0, 3).map((entry) => ({ ...entry, subject: actor.subject }));
    throw new Error("Proof query must not run for restricted dependencies");
  });
  const result = await f.read();
  expect(result).toMatchObject({ coverage: "UNASSESSABLE", items: [], inventory: null });
  expect(JSON.stringify(result)).not.toContain(id(599));
  expect(f.tx.$queryRawUnsafe.mock.calls.every(([sql]) => !sql.includes("jsonb_to_recordset"))).toBe(true);
});
it("rejects unknown outcomes that contradict the prepared candidate", async () => {
  const f = fixture();
  const invalid = { ...f.built, coverage: "PARTIAL", input: { ...f.built.input, coverage: "PARTIAL", candidates: [
    f.built.input.candidates[0]!, { ...f.built.input.candidates[0]!, raidItemId: id(4), key: "ISSUE-2", outcome: "UNKNOWN_CLASSIFICATION" },
  ] }, result: { ...f.built.result, coverage: "PARTIAL", candidateCount: 2, noOpenBlockers: null } };
  f.build.mockResolvedValueOnce(invalid as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  const future = { ...invalid, input: { ...invalid.input, candidates: [invalid.input.candidates[0],
    { ...invalid.input.candidates[1], outcome: "UNASSESSABLE_OPENED_AT" }] } };
  f.build.mockResolvedValueOnce(future as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
});
it("retains a known aged case while withholding future or unresolved opened-date candidates", async () => {
  const f = fixture();
  const candidate = { ...f.built.input.candidates[0]!, raidItemId: id(4), key: "ISSUE-2", classification: rawProof(true, 13),
    openedAt: rawProof("2026-10-22", 14), outcome: "UNASSESSABLE_OPENED_AT", age: undefined, thresholdExceeded: undefined };
  const partial = { ...f.built, coverage: "PARTIAL", input: { ...f.built.input, coverage: "PARTIAL", candidates: [f.built.input.candidates[0], candidate],
    authorityRevisions: [...f.built.input.authorityRevisions, authority(`raid_item.${id(4)}.blocks_delivery`, 13), authority(`raid_item.${id(4)}.opened_at`, 14)],
    dependencies: [...f.built.input.dependencies, { factId: id(13), sourceId: id(513) }, { factId: id(14), sourceId: id(514) }] },
    result: { ...f.built.result, coverage: "PARTIAL", candidateCount: 2, noOpenBlockers: null } };
  f.build.mockResolvedValueOnce(partial as never);
  const future = await f.read();
  expect(future).toMatchObject({ coverage: "PARTIAL", noOpenBlockers: null, items: [{ key: "ISSUE-1" }] });
  expect(JSON.stringify(future)).not.toContain("2026-10-22"); expect(JSON.stringify(future)).not.toContain(id(14));
  expect(f.readable).toHaveBeenLastCalledWith(f.tx, actor, projectId, { blockerAge: partial.input });
  expect(String(f.tx.$queryRawUnsafe.mock.calls.at(-1)?.[3])).not.toContain(id(14));
  const unknown = { ...partial, input: { ...partial.input, candidates: [partial.input.candidates[0], { ...candidate,
    openedAt: { status: "UNKNOWN", value: null, factId: id(14), versionIds: [], evidenceIds: [] } }] } };
  f.build.mockResolvedValueOnce(unknown as never);
  const missing = await f.read();
  expect(missing).toMatchObject({ coverage: "PARTIAL", noOpenBlockers: null, items: [{ key: "ISSUE-1" }] });
  expect(JSON.stringify(missing)).not.toContain(id(14));
});
it("normalizes a genuinely unattested inventory without exposing its input", async () => {
  const f = fixture();
  f.build.mockResolvedValueOnce({ ...f.built, coverage: "UNASSESSABLE", input: { ...f.built.input,
    coverage: "UNASSESSABLE", gates: { ...f.built.input.gates, inventoryAttested: false },
    inventoryCompleteness: { ...f.built.input.inventoryCompleteness, value: false } },
    result: { ...f.built.result, coverage: "UNASSESSABLE", noOpenBlockers: null } } as never);
  const result = await f.read();
  expect(result).toMatchObject({ coverage: "UNASSESSABLE", noOpenBlockers: null, inventory: null, items: [] });
  expect(JSON.stringify(result)).not.toContain(id(11));
  expect(JSON.stringify(result)).not.toContain("ISSUE-1");
  expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
});
it("does not convert a strict preparation error or a false attestation into a positive result", async () => {
  const f = fixture(); f.build.mockRejectedValueOnce(new Error("Synthetic infrastructure failure"));
  await expect(f.read()).rejects.toThrow("Synthetic infrastructure failure");
  f.build.mockResolvedValueOnce({ ...f.built, input: { ...f.built.input,
    inventoryCompleteness: { ...f.built.input.inventoryCompleteness, value: false } } } as never);
  await expect(f.read()).rejects.toThrow("Blocker-age advice unavailable");
  expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
});

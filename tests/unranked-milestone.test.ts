import { describe, expect, it } from "vitest";
import { unrankedMilestoneObservationSchema as schema, unrankedMilestoneFromSnapshot } from "../packages/domain/src/unranked-milestone.js";
import { resolveSourceAuthority, type SourceAuthoritySnapshot } from "../packages/domain/src/source-authority.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asOf = "2026-10-31T12:00:00.000Z";
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 100), sourceId: id(n + 200),
  provenance: "HUMAN_CONFIRMED", effectiveAt: "2026-10-30T12:00:00.000Z",
  observedAt: "2026-10-30T12:00:00.000Z", versionValidUntil: "2026-11-01T12:00:00.000Z" });
const observation = () => ({ kind: "UNRANKED_NO_POLICY", projectId: id(1), milestoneId: id(2),
  bindingId: id(3), factId: id(4), factType: "canonical.state.00000000000040008000000000000002", asOf,
  positions: [{ state: "OPEN", supports: [support(10), support(11)] },
    { state: "COMPLETE", supports: [support(12)] }] });

describe("unranked human milestone observation shape", () => {
  it("retains all distinct alternatives without a policy or selected value", () => {
    const input = observation();
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ...input, policyRevisionId: id(5) }).success).toBe(false);
    expect(schema.safeParse({ ...input, resolvedValue: "COMPLETE" }).success).toBe(false);
  });
  it("rejects missing, expired and future-dated evidence", () => {
    for (const change of [
      { versionValidUntil: null }, { versionValidUntil: asOf },
      { effectiveAt: "2026-11-01T12:00:00.000Z" }, { observedAt: "2026-11-01T12:00:00.000Z" },
      { provenance: "SYSTEM_VERIFIED" },
    ]) {
      const input = observation(); Object.assign(input.positions[0]!.supports[0]!, change);
      expect(schema.safeParse(input).success).toBe(false);
    }
  });
  it("rejects duplicated states, versions, evidence or sources and incomplete alternatives", () => {
    const sameState = observation(); sameState.positions[1]!.state = "OPEN";
    expect(schema.safeParse(sameState).success).toBe(false);
    const sameVersion = observation(); sameVersion.positions[1]!.supports[0]!.versionId = sameVersion.positions[0]!.supports[0]!.versionId;
    expect(schema.safeParse(sameVersion).success).toBe(false);
    const sameEvidence = observation(); sameEvidence.positions[1]!.supports[0]!.evidenceId = sameEvidence.positions[0]!.supports[0]!.evidenceId;
    expect(schema.safeParse(sameEvidence).success).toBe(false);
    const sameSource = observation(); sameSource.positions[1]!.supports[0]!.sourceId = sameSource.positions[0]!.supports[0]!.sourceId;
    expect(schema.safeParse(sameSource).success).toBe(false);
    const sameSourceWithin = observation(); sameSourceWithin.positions[0]!.supports[1]!.sourceId = sameSourceWithin.positions[0]!.supports[0]!.sourceId;
    expect(schema.safeParse(sameSourceWithin).success).toBe(false);
    const one = observation(); one.positions.pop();
    expect(schema.safeParse(one).success).toBe(false);
  });
  it("rejects malformed or oversized observations", () => {
    const unknown = observation(); unknown.positions[0]!.state = "UNKNOWN";
    expect(schema.safeParse(unknown).success).toBe(false);
    const large = observation(); large.positions[0]!.supports = Array.from({ length: 1001 }, (_, i) => support(i + 1000));
    expect(schema.safeParse(large).success).toBe(false);
    const invalidDate = observation(); invalidDate.positions[0]!.supports[0]!.observedAt = "2026-02-30T12:00:00.000Z";
    expect(schema.safeParse(invalidDate).success).toBe(false);
    const extra = observation(); Object.assign(extra.positions[0]!.supports[0]!, { hidden: true });
    expect(schema.safeParse(extra).success).toBe(false);
  });
  it("enforces the output byte bound independently of per-position counts", () => {
    const build = (count: number) => {
      const input = observation();
      input.positions[0]!.supports = Array.from({ length: count - 1 }, (_, i) => support(i + 1000));
      input.positions[1]!.supports = [support(count + 1000)];
      return input;
    };
    const under = build(830), over = build(840);
    expect(new TextEncoder().encode(JSON.stringify(under)).length).toBeLessThanOrEqual(262144);
    expect(schema.safeParse(under).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(over)).length).toBeGreaterThan(262144);
    expect(schema.safeParse(over).success).toBe(false);
  });
});

describe("unranked projection of a complete authority snapshot", () => {
  const scope = { customerId: id(1), projectId: id(2), factId: id(3),
    factType: "canonical.state.00000000000040008000000000000002" };
  const target = { milestoneId: id(4), bindingId: id(5) };
  const fixture = (): SourceAuthoritySnapshot => {
    const versions: SourceAuthoritySnapshot["versions"] = ["OPEN", "COMPLETE"].map((state, i) => ({
      id: id(10 + i), scope, source: { instanceId: id(20 + i), recordType: "human_statement",
        recordId: id(20 + i), revision: id(30 + i) }, value: { type: "text", value: state },
      provenance: "HUMAN_CONFIRMED", effectiveAt: "2026-10-30T12:00:00.000Z",
      observedAt: "2026-10-30T12:00:00.000Z", validUntil: "2026-11-01T12:00:00.000Z",
      evidenceIds: [id(30 + i)], approval: { state: "NOT_REQUIRED", decisionId: null, decisionAt: null },
    }));
    return { scope, asOf, complete: true, policy: null, versions, conflicts: [],
      sources: versions.map((v) => ({ instanceId: v.source.instanceId, sourceType: "human_statement" })),
      evidence: versions.map((v) => ({ id: v.evidenceIds[0]!, scope, access: "AUTHORIZED", verification: "VALID" })) };
  };
  it("projects different unexpired, accessible human heads with no policy", () => {
    const output = unrankedMilestoneFromSnapshot(fixture(), target);
    expect(output?.positions.map((p) => p.state)).toEqual(["COMPLETE", "OPEN"]);
    expect(output?.kind).toBe("UNRANKED_NO_POLICY");
    expect(output?.positions.find((p) => p.state === "OPEN")?.supports[0]).toMatchObject({
      versionId: id(10), evidenceId: id(30), sourceId: id(20),
    });
  });
  it("withholds restricted, expired, incomplete or unsupported input", () => {
    const restricted = fixture(); restricted.evidence[0]!.access = "RESTRICTED";
    const expired = fixture(); expired.versions[0]!.validUntil = asOf;
    const unknown = fixture(); unknown.versions[0]!.validUntil = null;
    const incomplete = fixture(); incomplete.complete = false;
    const nonhuman = fixture(); nonhuman.versions[0]!.provenance = "SYSTEM_VERIFIED";
    for (const input of [restricted, expired, unknown, incomplete, nonhuman])
      expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
  });
  it("does not present a single shared state as disagreement", () => {
    const input = fixture(); input.versions[1]!.value = { type: "text", value: "OPEN" };
    expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
  });
  it("withholds a valid snapshot with an active authority policy", () => {
    const input = fixture();
    input.policy = { revisionId: id(50), customerId: scope.customerId, projectId: scope.projectId,
      factType: scope.factType, recordedAt: "2026-10-30T12:00:00.000Z", effectiveAt: "2026-10-30T12:00:00.000Z",
      tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED", validity: null }] }],
      conflictBehavior: "RETAIN_CONFLICT" };
    expect(resolveSourceAuthority(input).policy).not.toBeNull();
    expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
  });
  it("rejects unsupported approval and source-to-evidence associations", () => {
    const approvals: SourceAuthoritySnapshot["versions"][number]["approval"][] = [
      { state: "PENDING", decisionId: null, decisionAt: null },
      { state: "REJECTED", decisionId: id(80), decisionAt: "2026-10-30T13:00:00.000Z" },
      { state: "APPROVED", decisionId: id(81), decisionAt: "2026-10-30T13:00:00.000Z" },
      { state: "REJECTED", decisionId: id(82), decisionAt: "2026-11-01T12:00:00.000Z" },
    ];
    for (const approval of approvals) {
      const input = fixture();
      input.versions[0]!.approval = approval;
      expect(resolveSourceAuthority(input).status).toBe("NO_POLICY");
      expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
    }
    const mismatch = fixture(); mismatch.versions[0]!.source.revision = id(90);
    expect(resolveSourceAuthority(mismatch).status).toBe("NO_POLICY");
    expect(unrankedMilestoneFromSnapshot(mismatch, target)).toBeNull();
    expect(unrankedMilestoneFromSnapshot(fixture(), { ...target, bindingId: "invalid" })).toBeNull();
  });
  it("retains the latest applicable source head and still requires historical access", () => {
    const input = fixture();
    const old = structuredClone(input.versions[0]!);
    old.id = id(12); old.value = { type: "text", value: "COMPLETE" };
    old.effectiveAt = "2026-10-29T12:00:00.000Z"; old.observedAt = old.effectiveAt;
    old.source.revision = id(32); old.evidenceIds = [id(32)];
    input.versions.push(old);
    input.evidence.push({ id: id(32), scope, access: "AUTHORIZED", verification: "VALID" });
    const output = unrankedMilestoneFromSnapshot(input, target);
    expect(output?.positions.map((p) => p.state)).toEqual(["COMPLETE", "OPEN"]);
    expect(output?.positions.flatMap((p) => p.supports).map((s) => s.versionId)).not.toContain(id(12));
    input.evidence[2]!.access = "RESTRICTED";
    expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
  });
  it("does not reactivate an older version when the newest head expires", () => {
    const input = fixture();
    const old = structuredClone(input.versions[0]!);
    old.id = id(12); old.effectiveAt = "2026-10-29T12:00:00.000Z"; old.observedAt = old.effectiveAt;
    old.source.revision = id(32); old.evidenceIds = [id(32)]; input.versions.push(old);
    input.evidence.push({ id: id(32), scope, access: "AUTHORIZED", verification: "VALID" });
    input.versions[0]!.validUntil = asOf;
    expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
  });
  it("withholds malformed historical source/evidence identity", () => {
    const input = fixture();
    const old = structuredClone(input.versions[0]!);
    old.id = id(12); old.effectiveAt = "2026-10-29T12:00:00.000Z"; old.observedAt = old.effectiveAt;
    old.source.revision = id(90); old.evidenceIds = [id(32)]; input.versions.push(old);
    input.evidence.push({ id: id(32), scope, access: "AUTHORIZED", verification: "VALID" });
    expect(resolveSourceAuthority(input).status).toBe("NO_POLICY");
    expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
    old.source.revision = id(31); old.evidenceIds = [id(31)];
    input.evidence.pop();
    expect(resolveSourceAuthority(input).status).toBe("NO_POLICY");
    expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
  });
  it("withholds tied heads for a single source rather than choosing one", () => {
    const input = fixture();
    const tied = structuredClone(input.versions[0]!);
    tied.id = id(12); tied.value = { type: "text", value: "COMPLETE" };
    tied.source.revision = id(32); tied.evidenceIds = [id(32)];
    input.versions.push(tied);
    input.evidence.push({ id: id(32), scope, access: "AUTHORIZED", verification: "VALID" });
    expect(unrankedMilestoneFromSnapshot(input, target)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  evaluateMilestoneConsistency as evaluate,
  type MilestoneConsistencySnapshot,
  type SourceAuthoritySnapshot,
} from "../packages/domain/src/index.js";

const id = (n: number) =>
  `abcdefab-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = (n: number) =>
  `2026-09-${String(n).padStart(2, "0")}T12:00:00.000Z`;
type State = "OPEN" | "IN_PROGRESS" | "COMPLETE" | "CANCELLED";
function fixture(
  states: State[] = ["OPEN", "OPEN", "OPEN"],
): MilestoneConsistencySnapshot {
  const targets = ["COMPLETE", ...states].map((value, n) => {
    const targetKind =
      n === 0 ? ("MILESTONE" as const) : ("WORK_ITEM" as const);
    const targetId = id(10 + n);
    const scope = {
      customerId: id(1),
      projectId: id(2),
      factId: id(100 + n),
      factType: "delivery.state",
    };
    const snapshot: SourceAuthoritySnapshot = {
      scope,
      asOf: time(5),
      complete: true,
      policy: {
        revisionId: id(200 + n),
        customerId: id(1),
        projectId: id(2),
        factType: scope.factType,
        recordedAt: time(1),
        effectiveAt: time(1),
        conflictBehavior: "REQUEST_RECONCILIATION",
        tiers: [
          {
            selectors: [
              {
                sourceType: "human_statement",
                instanceId: null,
                requiredApproval: "NOT_REQUIRED",
                validity: null,
              },
            ],
          },
        ],
      },
      versions: [
        {
          id: id(300 + n),
          scope: { ...scope },
          source: {
            instanceId: id(400 + n),
            recordType: "statement",
            recordId: "state",
            revision: "1",
          },
          value: { type: "text", value },
          provenance: "HUMAN_CONFIRMED",
          observedAt: time(1),
          effectiveAt: time(1),
          validUntil: time(10),
          evidenceIds: [id(500 + n)],
          approval: {
            state: "NOT_REQUIRED",
            decisionId: null,
            decisionAt: null,
          },
        },
      ],
      conflicts: [],
      sources: [{ instanceId: id(400 + n), sourceType: "human_statement" }],
      evidence: [
        {
          id: id(500 + n),
          scope: { ...scope },
          access: "AUTHORIZED",
          verification: "VALID",
        },
      ],
    };
    return {
      targetKind,
      targetId,
      snapshot,
      binding: {
        id: id(600 + n),
        customerId: id(1),
        projectId: id(2),
        targetKind,
        targetId,
        field: "state" as const,
        factId: scope.factId,
        factType: scope.factType,
      },
    };
  });
  return {
    scope: { customerId: id(1), projectId: id(2), milestoneId: id(10) },
    asOf: time(5),
    ruleRevision: "milestone-required-state/v1",
    enabled: true,
    complete: true,
    requiredWorkItemIds: targets.slice(1).map((t) => t.targetId),
    targets,
  };
}
const fact = (input: MilestoneConsistencySnapshot, index = 0) =>
  input.targets[index]!.snapshot!;
function addVersion(snapshot: SourceAuthoritySnapshot, n: number) {
  const original = snapshot.versions[0]!;
  snapshot.versions.push({
    ...structuredClone(original),
    id: id(n),
    source: { ...original.source, instanceId: id(n + 100000) },
    evidenceIds: [id(n + 200000)],
  });
  snapshot.sources.push({
    instanceId: id(n + 100000),
    sourceType: "human_statement",
  });
  snapshot.evidence.push({
    id: id(n + 200000),
    scope: { ...snapshot.scope },
    access: "AUTHORIZED",
    verification: "VALID",
  });
}
const minimal = (input: MilestoneConsistencySnapshot, status: string) => ({
  scope: input.scope,
  asOf: input.asOf,
  ruleRevision: input.ruleRevision,
  status,
});
const rejects = (input: unknown) => {
  try {
    evaluate(input);
    throw new Error("Expected failure");
  } catch (error) {
    expect(String(error)).toBe("Error: Invalid milestone consistency snapshot");
    expect(error).not.toHaveProperty("cause");
  }
};

describe("FR-EVD-004/009/010/012: internal milestone contradiction (partial AC-EVD-004)", () => {
  it("retains the Complete milestone and all three mandatory Open positions without changing scalar dimensions", () => {
    const input = fixture();
    const out = evaluate(input);
    expect(out.status).toBe("CONFLICTING");
    expect(out.contributors).toHaveLength(4);
    expect(out.evaluations).toHaveLength(4);
    expect(out.dependencies).toHaveLength(4);
    for (const row of out.evaluations!) {
      expect(row.assessment!.status).toBe("RESOLVED");
      expect(row.assessment!.versions[0]).toMatchObject({
        assessment: {
          provenance: "HUMAN_CONFIRMED",
          freshness: "CURRENT",
          conflict: "NONE",
        },
      });
    }
    expect(out).not.toHaveProperty("requestId");
    expect(out).not.toHaveProperty("recipient");
    expect(out).not.toHaveProperty("settled");
  });
  it("includes IN_PROGRESS and all agreeing sources; complete noncontributors remain dependencies", () => {
    const input = fixture(["IN_PROGRESS", "OPEN", "COMPLETE"]);
    addVersion(fact(input), 700);
    const out = evaluate(input);
    expect(out.status).toBe("CONFLICTING");
    expect(out.contributors).toHaveLength(3);
    expect(out.dependencies).toHaveLength(4);
    expect(out.contributors![0]!.supportingVersionIds).toEqual([
      id(300),
      id(700),
    ]);
    expect(out.contributors![0]!.supportingEvidenceIds).toEqual([
      id(500),
      id(200700),
    ]);
    expect(out.contributorIdentity).toContain(id(700));
    expect(out.contributorIdentity).toContain(id(200700));
  });
  it.each(["OPEN", "IN_PROGRESS", "COMPLETE"] as State[])(
    "only reports NOT_DETECTED for a noncontradictory %s milestone",
    (value) => {
      const input = fixture(value === "COMPLETE" ? ["COMPLETE"] : ["OPEN"]);
      fact(input).versions[0]!.value = { type: "text", value };
      const out = evaluate(input);
      expect(out.status).toBe("NOT_DETECTED");
      expect(out.contributorIdentity).toBeUndefined();
      expect(out.contributors).toBeUndefined();
    },
  );
  it("does not treat an empty mandatory set as proof of completion", () => {
    expect(evaluate(fixture([])).status).toBe("UNKNOWN");
  });
  it.each([
    "missing",
    "policy",
    "future-policy",
    "expired",
    "unknown-expiry",
    "inference",
    "unknown-origin",
    "pending",
    "future-observed",
    "future-effective",
    "cancelled",
    "cancelled-milestone",
    "ambiguous",
    "disagreement",
  ])(
    "does not resolve %s even alongside a known contradictory pair",
    (fault) => {
      const input = fixture();
      const f = fact(input, 3);
      const v = f.versions[0]!;
      if (fault === "missing") {
        input.targets[3]!.binding = null;
        input.targets[3]!.snapshot = null;
      }
      if (fault === "policy") f.policy = null;
      if (fault === "future-policy") f.policy!.effectiveAt = time(6);
      if (fault === "expired") v.validUntil = time(5);
      if (fault === "unknown-expiry") v.validUntil = null;
      if (fault === "inference") v.provenance = "AGENT_INFERENCE";
      if (fault === "unknown-origin") v.provenance = "UNKNOWN";
      if (fault === "pending") {
        f.policy!.tiers[0]!.selectors[0]!.requiredApproval = "APPROVED";
        v.approval.state = "PENDING";
      }
      if (fault === "future-observed") v.observedAt = time(6);
      if (fault === "future-effective") v.effectiveAt = time(6);
      if (fault === "cancelled") v.value = { type: "text", value: "CANCELLED" };
      if (fault === "cancelled-milestone")
        fact(input).versions[0]!.value = { type: "text", value: "CANCELLED" };
      if (fault === "ambiguous" || fault === "disagreement") {
        addVersion(f, 700);
        if (fault === "ambiguous") {
          f.versions[1]!.source = { ...v.source, revision: "2" };
          f.sources.pop();
        } else f.versions[1]!.value = { type: "text", value: "COMPLETE" };
      }
      const out = evaluate(input);
      expect(out.status).toBe("UNKNOWN");
      expect(out.contributors).toBeUndefined();
      expect(out.contributorIdentity).toBeUndefined();
      if (fault === "policy")
        expect(out.evaluations![3]!.assessment!.status).toBe("NO_POLICY");
    },
  );
  it.each(["RESTRICTED", "REVOKED", "DELETED", "UNVERIFIABLE"])(
    "withholds the entire proof for %s including an otherwise unused complete target",
    (fault) => {
      const input = fixture(["OPEN", "COMPLETE"]);
      const evidence = fact(input, 2).evidence[0]!;
      if (fault === "RESTRICTED") evidence.access = fault;
      else
        evidence.verification = fault as "REVOKED" | "DELETED" | "UNVERIFIABLE";
      input.targets[1]!.binding = null;
      input.targets[1]!.snapshot = null;
      expect(evaluate(input)).toEqual(minimal(input, "REVALIDATION_REQUIRED"));
    },
  );
  it.each(["request", "scalar", "disabled"])(
    "uses only a minimal envelope for %s",
    (fault) => {
      const input = fixture();
      if (fault === "request") input.complete = false;
      if (fault === "scalar") fact(input).complete = false;
      if (fault === "disabled") input.enabled = false;
      expect(evaluate(input)).toEqual(
        minimal(input, fault === "disabled" ? "DISABLED" : "INCOMPLETE"),
      );
    },
  );
  it("does not revive a superseded current value when its new head is untrusted", () => {
    const input = fixture(["OPEN"]);
    const f = fact(input);
    addVersion(f, 700);
    f.versions[1]!.source = { ...f.versions[0]!.source, revision: "2" };
    f.sources.pop();
    f.versions[1]!.observedAt = time(3);
    f.versions[1]!.effectiveAt = time(3);
    f.versions[1]!.provenance = "AGENT_INFERENCE";
    expect(evaluate(input).status).toBe("UNKNOWN");
  });
  it.each([
    "customer",
    "project",
    "milestone",
    "target",
    "field",
    "fact",
    "fact-type",
    "version-scope",
    "evidence-scope",
    "time",
    "rule",
    "state",
    "typed-state",
    "origin",
    "duplicate-link",
    "duplicate-target",
    "duplicate-binding",
    "duplicate-fact",
    "duplicate-version",
    "duplicate-evidence",
    "missing-target",
    "orphan-target",
    "orphan-evidence",
    "missing-source",
    "binding-without-snapshot",
    "snapshot-without-binding",
    "forged-assessment",
  ])("rejects malformed %s without reflecting source text", (fault) => {
    const input = fixture();
    const b = input.targets[0]!.binding!;
    const f = fact(input);
    const v = f.versions[0]!;
    if (fault === "customer") b.customerId = id(900);
    if (fault === "project") b.projectId = id(900);
    if (fault === "milestone") input.scope.milestoneId = id(900);
    if (fault === "target") b.targetId = id(900);
    if (fault === "field") Object.assign(b, { field: "canary" });
    if (fault === "fact") b.factId = id(900);
    if (fault === "fact-type") b.factType = "canary";
    if (fault === "version-scope") v.scope.projectId = id(900);
    if (fault === "evidence-scope") f.evidence[0]!.scope.projectId = id(900);
    if (fault === "time") f.asOf = time(6);
    if (fault === "rule") Object.assign(input, { ruleRevision: "canary" });
    if (fault === "state") v.value = { type: "text", value: "canary" };
    if (fault === "typed-state") v.value = { type: "boolean", value: true };
    if (fault === "origin") Object.assign(v, { provenance: "canary" });
    if (fault === "duplicate-link")
      input.requiredWorkItemIds.push(input.requiredWorkItemIds[0]!);
    if (fault === "duplicate-target") input.targets.push(input.targets[0]!);
    if (fault === "duplicate-binding") input.targets[1]!.binding!.id = b.id;
    if (fault === "duplicate-fact") {
      input.targets[1]!.binding!.factId = b.factId;
      fact(input, 1).scope.factId = b.factId;
    }
    if (fault === "duplicate-version") fact(input, 1).versions[0]!.id = v.id;
    if (fault === "duplicate-evidence")
      fact(input, 1).evidence[0]!.id = f.evidence[0]!.id;
    if (fault === "missing-target") input.targets.pop();
    if (fault === "orphan-target") input.targets[1]!.targetId = id(900);
    if (fault === "orphan-evidence")
      f.evidence.push({ ...f.evidence[0]!, id: id(900) });
    if (fault === "missing-source") f.sources = [];
    if (fault === "binding-without-snapshot") input.targets[0]!.snapshot = null;
    if (fault === "snapshot-without-binding") input.targets[0]!.binding = null;
    if (fault === "forged-assessment")
      Object.assign(f, { resolved: true, canary: "private text" });
    rejects(input);
  });
  it("is permutation-stable, detached and deeply frozen", () => {
    const input = fixture();
    addVersion(fact(input), 700);
    const before = structuredClone(input);
    const out = evaluate(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    const checkFrozen = (value: unknown) => {
      if (value && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(checkFrozen);
      }
    };
    checkFrozen(out);
    input.targets.reverse();
    input.requiredWorkItemIds.reverse();
    for (const target of input.targets) {
      target.snapshot!.versions.reverse();
      target.snapshot!.evidence.reverse();
      target.snapshot!.sources.reverse();
    }
    expect(evaluate(input)).toEqual(out);
    fact(input).versions[0]!.value = { type: "text", value: "CANCELLED" };
    expect(out.status).toBe("CONFLICTING");
  });
  it("dedupes unchanged contributors across time/policy revisions and distinguishes changed supporting evidence", () => {
    const input = fixture(["OPEN", "COMPLETE"]);
    const original = evaluate(input).contributorIdentity;
    input.asOf = time(6);
    for (const target of input.targets) {
      target.snapshot!.asOf = input.asOf;
      target.snapshot!.policy!.revisionId = id(
        800 + Number(target.targetId.slice(-2)),
      );
    }
    expect(evaluate(input).contributorIdentity).toBe(original);
    addVersion(fact(input, 2), 700);
    expect(evaluate(input).contributorIdentity).toBe(original);
    addVersion(fact(input), 701);
    expect(evaluate(input).contributorIdentity).not.toBe(original);
    const prior = evaluate(input).contributorIdentity;
    fact(input).evidence[0]!.id = id(900);
    fact(input).versions[0]!.evidenceIds = [id(900)];
    expect(evaluate(input).contributorIdentity).not.toBe(prior);
  });
  it("accepts 50 required targets and 1000 total versions but refuses larger snapshots without partial output", () => {
    const input = fixture(Array<State>(50).fill("OPEN"));
    expect(evaluate(input).status).toBe("CONFLICTING");
    for (let n = 0; n < 949; n++) addVersion(fact(input), 1000 + n);
    expect(evaluate(input).status).toBe("CONFLICTING");
    addVersion(fact(input), 2000);
    expect(evaluate(input)).toEqual(minimal(input, "INCOMPLETE"));
    const oversized = fixture(Array<State>(51).fill("OPEN"));
    expect(evaluate(oversized)).toEqual(minimal(oversized, "INCOMPLETE"));
  });
  it("preflights shared derived references including inactive conflicts at and above 64000", () => {
    const input = fixture(["OPEN"]);
    const f = fact(input);
    for (let n = 0; n < 31; n++) addVersion(f, 1000 + n);
    const ids = f.versions.map((v) => v.id);
    for (let n = 0; n < 998; n++)
      f.conflicts.push({
        id: id(5000 + n),
        scope: { ...f.scope },
        versionIds: n === 997 ? ids.slice(0, 30) : [...ids],
        detectedAt: time(2),
        resolvedAt: time(3),
      });
    expect(evaluate(input).status).toBe("CONFLICTING");
    f.conflicts[997]!.versionIds.push(ids[30]!);
    expect(evaluate(input)).toEqual(minimal(input, "INCOMPLETE"));
  });
  it("does not inspect deeply nested contents after a size-limit failure", () => {
    const input = fixture(["OPEN"]);
    const f = fact(input);
    f.evidence = new Array(64001);
    Object.defineProperty(f.evidence, 0, {
      get() {
        throw new Error("must not traverse oversized evidence");
      },
    });
    expect(evaluate(input)).toEqual(minimal(input, "INCOMPLETE"));
  });
});

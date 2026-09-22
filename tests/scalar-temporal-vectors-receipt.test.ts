// FR-EVD-004/006/007/012: independent temporal-vector corruption controls.
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resolveSourceAuthority } from "../packages/domain/src/index.js";
import {
  scalarSnapshot,
  scalarId,
  scalarTime,
} from "./fixtures/scalar-reconciliation.js";
import {
  assertScalarTemporalDimensions,
  assertScalarTemporalPolicy,
  assertScalarTemporalVectors,
} from "../scripts/acceptance/scalar-temporal-vectors-receipt.mjs";
const names = [
  "recorded-stale",
  "recorded-superseded",
  "higher-stale-contradiction",
  "higher-stale-agreement",
  "recorded-at-equal",
  "recorded-at-after",
];
function fixture(index: number) {
  const s = scalarSnapshot(),
    earlier = new Date(Date.parse(scalarTime) - 1000).toISOString();
  s.versions.forEach((v) => {
    v.provenance = "HUMAN_CONFIRMED";
    v.effectiveAt = earlier;
    v.observedAt = earlier;
  });
  s.policy!.recordedAt = earlier;
  s.policy!.effectiveAt = earlier;
  if (index < 2)
    s.policy!.tiers[0]!.selectors[0]!.validity = {
      basis: "effectiveAt",
      durationMs: 1,
    };
  if (index === 2 || index === 3)
    s.policy!.tiers = s.versions.map((v, i) => ({
      selectors: [
        {
          sourceType: "portfolio",
          instanceId: v.source.instanceId,
          requiredApproval: "NOT_REQUIRED",
          validity: i === 0 ? { basis: "effectiveAt", durationMs: 1 } : null,
        },
      ],
    }));
  if (index === 3) s.versions[1]!.value = { ...s.versions[0]!.value };
  else
    s.conflicts = [
      {
        id: scalarId(80),
        scope: { ...s.scope },
        versionIds: s.versions.map((v) => v.id),
        detectedAt: scalarTime,
        resolvedAt: null,
      },
    ];
  if (index === 1) {
    for (const v of [...s.versions]) {
      const id = scalarId(v.id === scalarId(10) ? 12 : 13),
        evidenceId = scalarId(v.id === scalarId(10) ? 212 : 213);
      s.versions.push({
        ...v,
        id,
        source: { ...v.source, revision: "2" },
        value: { type: "date", value: "2026-10-01" },
        evidenceIds: [evidenceId],
        effectiveAt: new Date(Date.parse(earlier) + 2).toISOString(),
        observedAt: new Date(Date.parse(earlier) + 2).toISOString(),
      });
      s.evidence.push({ ...s.evidence[0]!, id: evidenceId });
    }
  }
  if (index === 5) s.policy!.conflictBehavior = "RETAIN_CONFLICT";
  const result = structuredClone(resolveSourceAuthority(s));
  return {
    name: names[index],
    result: { assessment: { asOf: scalarTime, result } },
    after: {
      ProjectFactVersion: s.versions.map((v, i) => ({
        id: v.id,
        revision: i + 1,
        sourceId: v.source.instanceId,
        value: v.value,
        evidenceId: v.evidenceIds[0],
        effectiveAt: v.effectiveAt,
      })),
    },
  };
}
it.each(names.map((name, index) => ({ name, index })))(
  "accepts $name dimensions without dropping stale contributors",
  ({ index }) => {
    expect(assertScalarTemporalDimensions(fixture(index))).toBe(true);
  },
);
it.each([
  "freshness",
  "provenance",
  "conflict",
  "contributors",
  "evidence",
  "source",
  "head",
  "reason",
  "higher-group",
  "agreement",
  "new-head",
])("rejects %s corruption", (kind) => {
  const c: any = fixture(
    kind === "higher-group" ? 2 : kind === "agreement" ? 3 : 1,
  );
  const r = c.result.assessment.result,
    v = r.versions[0];
  if (kind === "freshness") v.assessment.freshness = "CURRENT";
  if (kind === "provenance") v.provenance = "SYSTEM_VERIFIED";
  if (kind === "conflict") v.assessment.conflict = "NONE";
  if (kind === "contributors") r.conflicts[0].versionIds.pop();
  if (kind === "evidence") r.conflicts[0].evidenceIds.pop();
  if (kind === "source") v.source.instanceId = scalarId(99);
  if (kind === "head") v.temporalApplicability = "APPLICABLE";
  if (kind === "reason") v.eligibilityReasons = ["STALE"];
  if (kind === "higher-group")
    r.conflicts = r.conflicts.filter(
      (g: any) => g.kind !== "HIGHER_AUTHORITY_CONTRADICTION",
    );
  if (kind === "agreement")
    c.after.ProjectFactVersion[0].value.value = "2026-10-03";
  if (kind === "new-head")
    c.after.ProjectFactVersion[2].sourceId = scalarId(99);
  expect(() => assertScalarTemporalDimensions(c)).toThrow();
});
function policyFixture(offset: number) {
  const tiers = [
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
  ];
  const previous = {
    id: scalarId(5),
    policyId: scalarId(4),
    customerId: scalarId(1),
    projectId: scalarId(2),
    factType: "project.forecast",
    revision: 1,
    recordedAt: "2026-09-13T11:00:00.000Z",
    effectiveAt: "2026-09-13T11:00:00.000Z",
    state: "ENABLED",
    definition: { tiers, conflictBehavior: "RETAIN_CONFLICT" },
  };
  const second = {
    ...previous,
    id: scalarId(6),
    revision: 2,
    recordedAt: new Date(Date.parse(scalarTime) + offset).toISOString(),
    definition: {
      tiers: structuredClone(tiers),
      conflictBehavior: "REQUEST_RECONCILIATION",
    },
  };
  const input = {
    projectId: scalarId(2),
    factType: "project.forecast",
    expectedRevision: 1,
    effectiveAt: second.effectiveAt,
    definition: second.definition,
  };
  const selected = offset === 0 ? second : previous;
  const c = {
    name: offset === 0 ? "recorded-at-equal" : "recorded-at-after",
    projectId: scalarId(2),
    actor: { subject: "pmo" },
    result: {
      assessment: {
        result: {
          policy: {
            ...structuredClone(selected.definition),
            revisionId: selected.id,
            customerId: selected.customerId,
            projectId: selected.projectId,
            factType: selected.factType,
            recordedAt: selected.recordedAt,
            effectiveAt: selected.effectiveAt,
          },
        },
      },
    },
    publication: {
      kind: "synthetic-same-transaction-publication",
      clockCalls: 1,
      offsetMs: offset,
      serverTime: scalarTime,
      input,
      revisionId: second.id,
      receiptId: scalarId(8),
      auditId: scalarId(9),
    },
    after: {
      ProjectFactVersion: [
        { sourceId: scalarId(10), revision: 1 },
        { sourceId: scalarId(11), revision: 2 },
      ],
      AuthorityPolicyRevision: [previous, second],
      AuthorityPolicyReceipt: [
        {
          id: scalarId(8),
          revisionId: second.id,
          subject: "pmo",
          requestHash: createHash("sha256")
            .update(JSON.stringify(input))
            .digest("hex"),
        },
      ],
      AuditEvent: [
        {
          id: scalarId(9),
          event: "authority.policy.appended",
          actor: "pmo",
          correlationId: "scalar-temporal-publication-unit",
          detail: {
            projectId: scalarId(2),
            policyId: second.policyId,
            revisionId: second.id,
            revision: 2,
          },
        },
      ],
    },
  };
  return {
    c,
    header: {
      asOf: scalarTime,
      policyThroughRevision: 2,
      policyId: previous.policyId,
      policyRevisionId: offset === 0 ? second.id : previous.id,
    },
  };
}
it.each([0, 1])(
  "independently selects recordedAt offset %i with effectiveAt already applicable",
  (offset) => {
    const { c, header } = policyFixture(offset);
    expect(assertScalarTemporalPolicy(c, header)).toBe(true);
  },
);
it.each([
  "offset",
  "future-effective",
  "prefix",
  "selection",
  "clock",
  "kind",
  "receipt",
  "audit",
  "hash",
  "delivered-time",
  "selector",
])("rejects boundary %s corruption", (kind) => {
  const { c, header }: any = policyFixture(1);
  if (kind === "delivered-time")
    c.result.assessment.result.policy.recordedAt = scalarTime;
  if (kind === "selector")
    c.after.AuthorityPolicyRevision[1].definition.tiers[0].selectors[0].instanceId =
      scalarId(99);
  if (kind === "offset")
    c.after.AuthorityPolicyRevision[1].recordedAt = new Date(
      Date.parse(scalarTime) + 2,
    ).toISOString();
  if (kind === "future-effective")
    c.after.AuthorityPolicyRevision[1].effectiveAt = new Date(
      Date.parse(scalarTime) + 1,
    ).toISOString();
  if (kind === "prefix") header.policyThroughRevision = 1;
  if (kind === "selection") header.policyRevisionId = scalarId(6);
  if (kind === "clock") c.publication.clockCalls = 2;
  if (kind === "kind") c.publication.kind = "public-clock-override";
  if (kind === "receipt") c.after.AuthorityPolicyReceipt = [];
  if (kind === "audit") c.after.AuditEvent[0].actor = "other";
  if (kind === "hash")
    c.after.AuthorityPolicyReceipt[0].requestHash = "0".repeat(64);
  expect(() => assertScalarTemporalPolicy(c, header)).toThrow();
});
it("requires all six native cases, not optional or duplicate coverage", () => {
  for (const cases of [
    [],
    names.slice(1).map((name) => ({ name })),
    names.map(() => ({ name: names[0] })),
  ])
    expect(() =>
      assertScalarTemporalVectors(
        { family: "scalar-temporal-vectors/v1", customerId: "customer", cases },
        "customer",
      ),
    ).toThrow();
});

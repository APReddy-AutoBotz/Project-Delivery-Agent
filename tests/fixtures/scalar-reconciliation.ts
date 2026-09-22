import {
  resolveSourceAuthority,
  type SourceAuthoritySnapshot,
} from "../../packages/domain/src/index.js";

export const scalarId = (n: number) =>
  `abcdefab-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const scalarScope = {
  customerId: scalarId(1),
  projectId: scalarId(2),
  factId: scalarId(3),
  factType: "project.forecast",
};
export const scalarTime = "2026-09-13T12:00:00.000Z";
export function scalarSnapshot(): SourceAuthoritySnapshot {
  const versions: SourceAuthoritySnapshot["versions"] = [10, 11].map((n) => ({
    id: scalarId(n),
    scope: { ...scalarScope },
    source: {
      instanceId: scalarId(n + 100),
      recordType: "project",
      recordId: "P-1",
      revision: "1",
    },
    value: { type: "date", value: n === 10 ? "2026-10-01" : "2026-10-02" },
    provenance: "SYSTEM_VERIFIED",
    observedAt: scalarTime,
    effectiveAt: scalarTime,
    validUntil: "2026-10-01T00:00:00.000Z",
    evidenceIds: [scalarId(n + 200)],
    approval: { state: "NOT_REQUIRED", decisionId: null, decisionAt: null },
  }));
  return {
    scope: { ...scalarScope },
    asOf: scalarTime,
    complete: true,
    policy: {
      revisionId: scalarId(5),
      customerId: scalarScope.customerId,
      projectId: scalarScope.projectId,
      factType: scalarScope.factType,
      recordedAt: scalarTime,
      effectiveAt: scalarTime,
      conflictBehavior: "REQUEST_RECONCILIATION",
      tiers: [
        {
          selectors: [
            {
              sourceType: "portfolio",
              instanceId: null,
              requiredApproval: "NOT_REQUIRED",
              validity: null,
            },
          ],
        },
      ],
    },
    versions,
    conflicts: [],
    sources: versions.map((version) => ({
      instanceId: version.source.instanceId,
      sourceType: "portfolio",
    })),
    evidence: versions.flatMap((version) =>
      version.evidenceIds.map((id) => ({
        id,
        scope: { ...scalarScope },
        access: "AUTHORIZED" as const,
        verification: "VALID" as const,
      })),
    ),
  };
}
export function scalarContractFixture() {
  const result = resolveSourceAuthority(scalarSnapshot());
  const assessment = {
    assessmentId: scalarId(6),
    factId: scalarScope.factId,
    asOf: scalarTime,
    historical: true as const,
    replayed: false,
    visibility: "available" as const,
    revalidationRequired: false as const,
    result,
  };
  const request = {
    id: scalarId(7),
    projectId: scalarScope.projectId,
    factId: scalarScope.factId,
    factType: scalarScope.factType,
    createdAt: scalarTime,
    state: "OPEN" as const,
    assignment: {
      id: scalarId(8),
      revision: 1,
      occurredAt: scalarTime,
      reason: "ASSIGNED" as const,
      recipientSubject: "pm-atlas",
    },
  };
  return {
    assessment,
    request,
    checked: {
      checkId: scalarId(9),
      outcome: "CREATED" as const,
      replayed: false,
      assessment,
      request,
    },
    restricted: {
      ...assessment,
      visibility: "restricted" as const,
      revalidationRequired: true as const,
      result: null,
    },
  };
}

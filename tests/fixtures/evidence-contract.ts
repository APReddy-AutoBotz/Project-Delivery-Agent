import { vi } from "vitest";
import { resolveSourceAuthority } from "../../packages/domain/dist/index.js";
import type {
  ProjectFactRepository,
  AuthorityRepository,
} from "../../packages/domain/src/index.js";

export const evidenceProject = "30000000-0000-4000-8000-000000000001";
export const evidenceId = "70000000-0000-4000-8000-000000000001";
export const factType = "project.forecast";
export const statement = {
  projectId: evidenceProject,
  factType,
  expectedRevision: 0,
  idempotencyKey: "contract-statement",
  value: { type: "date" as const, value: "2026-10-01" },
  effectiveAt: "2026-09-11T00:00:00.000Z",
  validUntil: null,
  originalStatement: "Synthetic forecast confirmation",
};
export const access = {
  projectId: evidenceProject,
  sourceId: evidenceId,
  expectedRevision: 1,
  state: "AVAILABLE" as const,
  readers: ["pm-atlas"],
};
export const policy = {
  projectId: evidenceProject,
  factType,
  expectedRevision: 0,
  idempotencyKey: "contract-policy",
  effectiveAt: statement.effectiveAt,
  definition: {
    tiers: [
      {
        selectors: [
          {
            sourceType: "human_statement",
            instanceId: null,
            requiredApproval: "NOT_REQUIRED" as const,
            validity: null,
          },
        ],
      },
    ],
    conflictBehavior: "RETAIN_CONFLICT" as const,
  },
};
export const capture = {
  projectId: evidenceProject,
  factType,
  idempotencyKey: "contract-capture",
};
export function evidenceContractFixture() {
  const entry = {
    id: evidenceId,
    revision: 1,
    sourceId: evidenceId,
    evidenceId,
    sourceAccessRevision: 1,
    visibility: "available" as const,
    revalidationRequired: false as const,
    content: {
      value: statement.value,
      originalStatement: statement.originalStatement,
      providedBy: "pm-atlas",
      provenance: "HUMAN_CONFIRMED" as const,
      effectiveAt: statement.effectiveAt,
      observedAt: statement.effectiveAt,
      confirmedAt: statement.effectiveAt,
      validUntil: null,
      source: {
        instanceId: evidenceId,
        recordType: "human_statement" as const,
        recordId: evidenceId,
        revision: evidenceId,
      },
      evidenceIds: [evidenceId] as [string],
    },
  };
  const event = {
    id: evidenceId,
    policyId: evidenceId,
    revision: 1,
    recordedAt: statement.effectiveAt,
    recordedBy: "pmo",
    effectiveAt: statement.effectiveAt,
    state: "ENABLED" as const,
    definition: policy.definition,
  };
  const result = resolveSourceAuthority({
    scope: {
      customerId: "10000000-0000-4000-8000-000000000001",
      projectId: evidenceProject,
      factId: evidenceId,
      factType,
    },
    asOf: statement.effectiveAt,
    complete: true,
    policy: null,
    versions: [],
    conflicts: [],
    sources: [],
    evidence: [],
  });
  const delivery = {
    assessmentId: evidenceId,
    factId: evidenceId,
    asOf: statement.effectiveAt,
    historical: true as const,
    replayed: false,
    visibility: "available" as const,
    revalidationRequired: false as const,
    result,
  };
  const facts = {
    listFacts: vi.fn(async () => ({
      canAppend: true,
      canConfigure: false,
      facts: [{ factId: evidenceId, factType, revision: 1 }],
      next: null,
    })),
    getHistory: vi.fn(async () => ({
      factId: evidenceId,
      factType,
      throughRevision: 1,
      entries: [entry],
      next: null,
      historical: true as const,
    })),
    appendHumanStatement: vi.fn(async () => ({
      factId: evidenceId,
      replayed: false,
      entry,
    })),
    getSourceAccess: vi.fn(async () => ({
      sourceId: evidenceId,
      revision: 1,
      state: "AVAILABLE" as const,
      readers: ["pm-atlas"],
    })),
    setSourceAccess: vi.fn(async () => ({ sourceId: evidenceId, revision: 2 })),
  } satisfies ProjectFactRepository;
  const authority = {
    getActivePolicy: vi.fn(async () => ({
      asOf: statement.effectiveAt,
      policyId: evidenceId,
      throughRevision: 1,
      event,
    })),
    appendPolicy: vi.fn(async () => ({ event, replayed: false })),
    captureAssessment: vi.fn(async () => delivery),
    getAssessment: vi.fn(async () => delivery),
  } satisfies AuthorityRepository;
  return { facts, authority, delivery, entry };
}
export async function exerciseEvidenceContracts(
  request: (
    path: string,
    status: number,
    token?: string,
    method?: string,
    body?: unknown,
  ) => Promise<unknown>,
  token: string,
) {
  const prefix = "/api/projects/" + evidenceProject;
  await request(prefix + "/facts", 200, token);
  await request(prefix + "/facts/" + factType + "/history", 200, token);
  await request(prefix + "/fact-statements", 201, token, "POST", statement);
  await request(prefix + "/fact-sources/" + evidenceId + "/access", 200, token);
  await request(
    prefix + "/fact-sources/" + evidenceId + "/access",
    200,
    token,
    "POST",
    access,
  );
  await request(prefix + "/facts/" + factType + "/authority", 200, token);
  await request(prefix + "/authority-policies", 201, token, "POST", policy);
  await request(prefix + "/assessments", 201, token, "POST", capture);
  await request(prefix + "/assessments/" + evidenceId, 200, token);
}

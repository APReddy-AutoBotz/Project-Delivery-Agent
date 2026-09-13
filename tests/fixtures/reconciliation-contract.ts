import { vi } from "vitest";
import type { MilestoneReconciliationRepository } from "../../packages/domain/src/index.js";
import {
  evidenceContractFixture,
  evidenceProject,
  evidenceId,
  statement,
} from "./evidence-contract.js";

// CI-FND-001 / FR-EVD-009: serialized contract fixtures, not acceptance evidence.
export const milestoneId = "80000000-0000-4000-8000-000000000001";
export const requestId = "90000000-0000-4000-8000-000000000001";
export const reconciliationPrefix = "/api/projects/" + evidenceProject;
export const bindingInput = {
  projectId: evidenceProject,
  targetKind: "MILESTONE" as const,
  targetId: milestoneId,
  idempotencyKey: "contract-binding",
  initialState: "COMPLETE" as const,
  effectiveAt: statement.effectiveAt,
  validUntil: null,
  originalStatement: "Synthetic milestone confirmation",
};
export const checkInput = {
  projectId: evidenceProject,
  milestoneId,
  ruleRevision: "milestone-required-state/v1" as const,
  enabled: false,
  idempotencyKey: "contract-reconciliation-check",
};
export const refreshInput = {
  projectId: evidenceProject,
  requestId,
  expectedAssignmentRevision: 1,
  idempotencyKey: "contract-assignment-refresh",
};
export function reconciliationContractFixture() {
  const assignment = {
    id: evidenceId,
    revision: 1,
    occurredAt: statement.effectiveAt,
    reason: "ASSIGNED" as const,
    recipientSubject: "pm-atlas",
  };
  const request = {
    id: requestId,
    projectId: evidenceProject,
    milestoneId,
    createdAt: statement.effectiveAt,
    state: "OPEN" as const,
    assignment,
  };
  const metadata = {
    assessmentId: evidenceId,
    projectId: evidenceProject,
    milestoneId,
    asOf: statement.effectiveAt,
    historical: true as const,
    replayed: false,
  };
  const restricted = {
    ...metadata,
    visibility: "restricted" as const,
    revalidationRequired: true as const,
    result: null,
  };
  const checked = {
    checkId: evidenceId,
    outcome: "NO_REQUEST" as const,
    replayed: false,
    request: null,
    assessment: {
      ...metadata,
      visibility: "available" as const,
      revalidationRequired: false as const,
      result: {
        scope: {
          customerId: "10000000-0000-4000-8000-000000000001",
          projectId: evidenceProject,
          milestoneId,
        },
        asOf: statement.effectiveAt,
        ruleRevision: checkInput.ruleRevision,
        status: "DISABLED" as const,
      },
    },
  };
  const repository = {
    createStateBinding: vi.fn(async () => ({
      id: evidenceId,
      projectId: evidenceProject,
      targetKind: "MILESTONE" as const,
      targetId: milestoneId,
      field: "state" as const,
      factId: evidenceId,
      factType: "milestone.state",
      createdAt: statement.effectiveAt,
      replayed: false,
      entry: evidenceContractFixture().entry,
    })),
    getContext: vi.fn(async () => ({
      projectId: evidenceProject,
      milestoneId,
      canAppend: true,
      canConfigure: false,
      targets: [
        {
          targetKind: "MILESTONE" as const,
          targetId: milestoneId,
          binding: null,
        },
      ],
    })),
    check: vi.fn(async () => checked),
    list: vi.fn<MilestoneReconciliationRepository["list"]>(async () => ({
      requests: [request],
      next: null,
      live: true as const,
    })),
    get: vi.fn(async () => ({ request, assessment: restricted })),
    refreshAssignment: vi.fn(async () => ({
      requestId,
      assignment: { ...assignment, revision: 2 },
      replayed: false,
    })),
  } satisfies MilestoneReconciliationRepository;
  return { repository, request, restricted, checked };
}
export async function exerciseReconciliationContracts(
  request: (
    path: string,
    status: number,
    token?: string,
    method?: string,
    body?: unknown,
  ) => Promise<unknown>,
  token: string,
) {
  const prefix = reconciliationPrefix;
  await request(prefix + "/state-bindings", 201, token, "POST", bindingInput);
  await request(
    prefix + "/milestones/" + milestoneId + "/reconciliation-context",
    200,
    token,
  );
  await request(
    prefix + "/milestone-reconciliation-checks",
    201,
    token,
    "POST",
    checkInput,
  );
  await request(prefix + "/reconciliation-requests/manage", 200, token);
  await request(prefix + "/reconciliation-requests", 200, token);
  await request(prefix + "/reconciliation-requests/" + requestId, 200, token);
  await request(
    prefix + "/reconciliation-requests/" + requestId + "/assignment",
    201,
    token,
    "POST",
    refreshInput,
  );
}

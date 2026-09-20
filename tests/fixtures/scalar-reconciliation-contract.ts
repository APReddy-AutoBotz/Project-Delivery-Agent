import { vi } from "vitest";
import type { ScalarReconciliationRepository } from "../../packages/domain/src/index.js";
import {
  evidenceContractFixture,
  evidenceProject,
  evidenceId,
  statement,
} from "./evidence-contract.js";

export const scalarFactId = evidenceId;
export const scalarRequestId = "90000000-0000-4000-8000-000000000002";
export const scalarCheckId = "60000000-0000-4000-8000-000000000001";

export const scalarCheckInput = {
  projectId: evidenceProject,
  factType: "project.forecast",
  asOf: statement.effectiveAt,
  idempotencyKey: "scalar-contract-check",
};

export const scalarRefreshInput = {
  projectId: evidenceProject,
  requestId: scalarRequestId,
  expectedAssignmentRevision: 1,
  idempotencyKey: "scalar-contract-refresh",
};

export const scalarResolveInput = {
  projectId: evidenceProject,
  requestId: scalarRequestId,
  asOf: statement.effectiveAt,
  idempotencyKey: "scalar-contract-resolve",
};

export function scalarReconciliationContractFixture() {
  const assignment = {
    id: evidenceId,
    revision: 1,
    occurredAt: statement.effectiveAt,
    reason: "ASSIGNED" as const,
    recipientSubject: "pm-atlas",
  };

  const request = {
    id: scalarRequestId,
    projectId: evidenceProject,
    factId: scalarFactId,
    factType: "project.forecast",
    createdAt: statement.effectiveAt,
    state: "OPEN" as const,
    resolvedAssessmentId: null,
    assignment,
  };

  const assessment = evidenceContractFixture().delivery;

  const checked = {
    checkId: scalarCheckId,
    outcome: "CREATED" as const,
    replayed: false,
    assessment,
    request,
  };

  const repository: ScalarReconciliationRepository = {
    getContext: vi.fn(async () => ({
      projectId: evidenceProject,
      factType: "project.forecast",
      canAppend: true,
      canConfigure: true,
      factId: scalarFactId,
    })),
    check: vi.fn(async () => checked),
    get: vi.fn(async () => ({
      request,
      assessment,
    })),
    list: vi.fn(async () => ({
      requests: [request],
      next: null,
      live: true as const,
    })),
    refreshAssignment: vi.fn(async () => ({
      requestId: scalarRequestId,
      assignment: { ...assignment, revision: 2 },
      replayed: false,
    })),
    resolve: vi.fn(async () => ({
      checkId: scalarCheckId,
      outcome: "RESOLVED" as const,
      replayed: false,
      assessment,
      request: {
        ...request,
        state: "RESOLVED" as const,
        resolvedAssessmentId: assessment.assessmentId,
      },
    })),
  };

  return {
    assignment,
    request,
    assessment,
    checked,
    repository,
  };
}

export async function exerciseScalarReconciliationContracts(
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
  await request(
    prefix + "/facts/project.forecast/reconciliation-context",
    200,
    token,
  );
  await request(
    prefix + "/facts/project.forecast/reconciliation-checks",
    201,
    token,
    "POST",
    scalarCheckInput,
  );
  await request(prefix + "/scalar-reconciliation-requests/manage", 200, token);
  await request(prefix + "/scalar-reconciliation-requests", 200, token);
  await request(
    prefix + "/scalar-reconciliation-requests/" + scalarRequestId,
    200,
    token,
  );
  await request(
    prefix + "/scalar-reconciliation-requests/" + scalarRequestId + "/assignment",
    201,
    token,
    "POST",
    scalarRefreshInput,
  );
  await request(
    prefix + "/scalar-reconciliation-requests/" + scalarRequestId + "/resolve",
    201,
    token,
    "POST",
    scalarResolveInput,
  );
}

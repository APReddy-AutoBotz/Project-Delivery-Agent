// AC-EVD-004 / NFR-REL-002: handcrafted reader controls, never runtime evidence.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertMilestoneReconciliationWorkflowReceipt } from "../scripts/acceptance/milestone-reconciliation-workflow-receipt.mjs";

const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const customerId = id(1),
  portfolioId = id(2),
  projectId = id(3),
  milestoneId = id(4),
  requestId = id(5),
  assessmentId = id(6),
  checkId = id(7),
  assignmentId = id(8),
  instant = "2026-09-13T00:00:00.000Z";

function observation(status, body, label = "handcrafted") {
  const bytes =
    status === 204
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(body), "utf8");
  return {
    label,
    status,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bodyBase64: bytes.toString("base64"),
    body: status === 204 ? null : body,
  };
}

function replaceBody(target, body) {
  Object.assign(target, observation(target.status, body, target.label));
}

function corruptAllAvailableProofs(value, corrupt) {
  // Keep all copies and byte digests consistent to exercise proof-to-binding
  // linkage rather than merely cross-response inequality.
  for (const response of [
    value.check.response,
    value.originalProof,
    value.sourceRegrant.proof,
    value.recreatedProof.proof,
  ]) {
    const body = structuredClone(response.body);
    corrupt(body.assessment.result);
    replaceBody(response, body);
  }
}

function sourceAccess(
  sourceId,
  beforeRevision,
  beforeState,
  beforeReaders,
  afterRevision,
  state,
  readers,
) {
  return {
    before: observation(200, {
      sourceId,
      revision: beforeRevision,
      state: beforeState,
      readers: beforeReaders,
    }),
    input: {
      projectId,
      sourceId,
      expectedRevision: beforeRevision,
      state,
      readers,
    },
    command: observation(200, { sourceId, revision: afterRevision }),
    after: observation(200, {
      sourceId,
      revision: afterRevision,
      state,
      readers,
    }),
  };
}

function makeReceipt() {
  const workItems = [1, 2, 3].map((number) => ({
      id: id(10 + number),
      key: "WI-" + number,
    })),
    targets = [
      {
        targetKind: "MILESTONE",
        targetId: milestoneId,
        initialState: "COMPLETE",
      },
      ...workItems.map((row) => ({
        targetKind: "WORK_ITEM",
        targetId: row.id,
        initialState: "OPEN",
      })),
    ],
    policyDefinition = {
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
      conflictBehavior: "REQUEST_RECONCILIATION",
    },
    bindings = targets.map((target, index) => {
      const bindingId = id(20 + index),
        factId = id(30 + index),
        versionId = id(40 + index),
        evidenceId = id(50 + index),
        sourceId = id(60 + index),
        factType = `canonical.state.${index}`;
      return {
        command: {
          projectId,
          ...target,
          effectiveAt: instant,
          validUntil: "2026-09-14T00:00:00.000Z",
          originalStatement: "Synthetic human-confirmed " + target.initialState,
          idempotencyKey: id(70 + index),
        },
        response: observation(201, {
          id: bindingId,
          projectId,
          targetKind: target.targetKind,
          targetId: target.targetId,
          field: "state",
          factId,
          factType,
          createdAt: instant,
          replayed: false,
          entry: {
            id: versionId,
            revision: 1,
            sourceId,
            evidenceId,
            sourceAccessRevision: 1,
            visibility: "available",
            revalidationRequired: false,
            content: {
              value: { type: "text", value: target.initialState },
              originalStatement:
                "Synthetic human-confirmed " + target.initialState,
              providedBy: "pmo-atlas",
              provenance: "HUMAN_CONFIRMED",
              effectiveAt: instant,
              observedAt: instant,
              confirmedAt: instant,
              validUntil: "2026-09-14T00:00:00.000Z",
              source: {
                instanceId: id(80 + index),
                recordType: "human_statement",
                recordId: sourceId,
                revision: versionId,
              },
              evidenceIds: [evidenceId],
            },
          },
        }),
      };
    }),
    policies = bindings.map((binding, index) => ({
      command: {
        projectId,
        factType: binding.response.body.factType,
        expectedRevision: 0,
        idempotencyKey: id(90 + index),
        effectiveAt: instant,
        definition: policyDefinition,
      },
      response: observation(201, {
        replayed: false,
        event: {
          id: id(100 + index),
          policyId: id(110 + index),
          revision: 1,
          recordedAt: instant,
          recordedBy: "pmo-atlas",
          effectiveAt: instant,
          state: "ENABLED",
          definition: policyDefinition,
        },
      }),
    })),
    sharing = bindings.map((binding, index) =>
      sourceAccess(
        binding.response.body.entry.sourceId,
        1,
        "AVAILABLE",
        ["pmo-atlas"],
        3 + index,
        "AVAILABLE",
        ["pm-atlas", "pmo-atlas"],
      ),
    ),
    evaluations = targets.map((target, index) => {
      const bound = bindings[index].response.body,
        versionId = bound.entry.id,
        evidenceId = bound.entry.evidenceId;
      return {
        targetKind: target.targetKind,
        targetId: target.targetId,
        binding: {
          id: bound.id,
          customerId,
          projectId,
          targetKind: target.targetKind,
          targetId: target.targetId,
          field: "state",
          factId: bound.factId,
          factType: bound.factType,
        },
        assessment: {
          scope: {
            customerId,
            projectId,
            factId: bound.factId,
            factType: bound.factType,
          },
          asOf: instant,
          mode: "HISTORICAL",
          policy: null,
          complete: true,
          status: "RESOLVED",
          revalidationRequired: false,
          selectedTier: 0,
          resolvedValue: { type: "text", value: target.initialState },
          candidateVersionIds: [versionId],
          supportingVersionIds: [versionId],
          supportingEvidenceIds: [evidenceId],
          conflict: "NONE",
          conflicts: [],
          reconciliationRequired: false,
          versions: [
            {
              id: versionId,
              evidenceIds: [evidenceId],
              visibility: "available",
              revalidationRequired: false,
              provenance: "HUMAN_CONFIRMED",
              assessment: {
                provenance: "HUMAN_CONFIRMED",
                freshness: "CURRENT",
                conflict: "NONE",
                classification: "HUMAN_CONFIRMED",
                assessedAt: instant,
              },
            },
          ],
        },
      };
    }),
    contributors = targets.map((target, index) => {
      const bound = bindings[index].response.body;
      return {
        targetKind: target.targetKind,
        targetId: target.targetId,
        bindingId: bound.id,
        factId: bound.factId,
        factType: bound.factType,
        supportingVersionIds: [bound.entry.id],
        supportingEvidenceIds: [bound.entry.evidenceId],
      };
    }),
    dependencies = bindings.map(({ response: { body: bound } }) => ({
      bindingId: bound.id,
      factId: bound.factId,
      versionIds: [bound.entry.id],
      evidenceIds: [bound.entry.evidenceId],
    })),
    result = {
      scope: { customerId, projectId, milestoneId },
      asOf: instant,
      ruleRevision: "milestone-required-state/v1",
      status: "CONFLICTING",
      evaluations,
      dependencies,
      contributors,
      contributorIdentity: "handcrafted-unit-only",
    },
    assessment = {
      assessmentId,
      projectId,
      milestoneId,
      asOf: instant,
      historical: true,
      replayed: false,
      visibility: "available",
      revalidationRequired: false,
      result,
    },
    assignment = {
      id: assignmentId,
      revision: 1,
      occurredAt: instant,
      reason: "ASSIGNED",
      recipientSubject: "pm-atlas",
    },
    request = {
      id: requestId,
      projectId,
      milestoneId,
      createdAt: instant,
      state: "OPEN",
      assignment,
    },
    delivery = { request, assessment },
    restricted = {
      request,
      assessment: {
        assessmentId,
        projectId,
        milestoneId,
        asOf: instant,
        historical: true,
        replayed: false,
        visibility: "restricted",
        revalidationRequired: true,
        result: null,
      },
    },
    operator = { customerId, subject: "operator", roles: ["system_admin"] },
    creator = { customerId, subject: "pmo-atlas", roles: ["pmo_admin"] },
    recipient = { customerId, subject: "pm-atlas", roles: ["project_manager"] },
    originalProof = observation(200, delivery),
    denial = { statusCode: 404, message: "Resource unavailable" },
    lastSource = bindings[3].response.body.entry.sourceId;
  return {
    status: "passed",
    projectId,
    requestId,
    milestoneId,
    ruleRevision: "milestone-required-state/v1",
    identities: {
      operator: observation(200, operator),
      creator: observation(200, creator),
      recipient: observation(200, recipient),
    },
    authorizationSetup: {
      creatorPortfolioGrant: {
        command: {
          subject: "pmo-atlas",
          scopeType: "portfolio",
          scopeId: portfolioId,
          role: "pmo_admin",
        },
        response: observation(204, null),
      },
      recipientProjectGrant: {
        command: {
          subject: "pm-atlas",
          scopeType: "project",
          scopeId: projectId,
          role: "project_manager",
        },
        response: observation(204, null),
      },
    },
    canonical: {
      command: { portfolioId },
      creation: observation(201, { id: projectId }),
      detail: observation(200, {
        id: projectId,
        creation: { by: "pmo-atlas" },
        responsibilities: [{ role: "PROJECT_MANAGER", subject: "pm-atlas" }],
        milestones: [{ id: milestoneId, key: "MS-1" }],
        workItems,
        requiredWorkItems: workItems.map((row) => ({
          milestoneKey: "MS-1",
          workItemKey: row.key,
        })),
      }),
    },
    targets,
    bindings,
    policies,
    sharing,
    check: {
      command: {
        projectId,
        milestoneId,
        enabled: true,
        ruleRevision: "milestone-required-state/v1",
        idempotencyKey: id(120),
      },
      response: observation(201, {
        checkId,
        outcome: "CREATED",
        replayed: false,
        assessment,
        request,
      }),
    },
    queues: {
      management: observation(200, {
        requests: [request],
        next: null,
        live: true,
      }),
      recipient: observation(200, {
        requests: [request],
        next: null,
        live: true,
      }),
    },
    originalProof,
    sourceWithdrawal: {
      access: sourceAccess(
        lastSource,
        sharing[3].after.body.revision,
        "AVAILABLE",
        ["pm-atlas", "pmo-atlas"],
        9,
        "REVOKED",
        ["pmo-atlas"],
      ),
      proof: observation(200, restricted),
    },
    sourceRegrant: {
      access: sourceAccess(
        lastSource,
        9,
        "REVOKED",
        ["pmo-atlas"],
        12,
        "AVAILABLE",
        ["pm-atlas", "pmo-atlas"],
      ),
      proof: structuredClone(originalProof),
    },
    screenshot: {
      file: "milestone-reconciliation-pm-proof.png",
      sha256: "a".repeat(64),
    },
    recreatedProof: {
      identity: observation(200, recipient),
      proof: structuredClone(originalProof),
      screenshot: {
        file: "milestone-reconciliation-pm-proof-recreated.png",
        sha256: "b".repeat(64),
      },
    },
    projectScopeWithdrawal: {
      operator: observation(200, operator),
      command: {
        input: {
          subject: "pm-atlas",
          scopeType: "project",
          scopeId: projectId,
        },
        response: observation(204, null),
      },
      uiDenial: observation(404, denial),
      directDenial: observation(404, denial),
      screenshot: {
        file: "milestone-reconciliation-pm-scope-denied.png",
        sha256: "c".repeat(64),
      },
    },
  };
}

describe("handcrafted milestone-reconciliation receipt reader", () => {
  it("accepts the linked positive shape only as unit input", () => {
    expect(() =>
      assertMilestoneReconciliationWorkflowReceipt(makeReceipt(), {
        expectedCustomerId: customerId,
      }),
    ).not.toThrow();
  });

  it("rejects retained-byte corruption and the wrong host-pinned customer", () => {
    const bytes = makeReceipt();
    bytes.originalProof.bodyBase64 = bytes.originalProof.bodyBase64.slice(4);
    expect(() =>
      assertMilestoneReconciliationWorkflowReceipt(bytes, {
        expectedCustomerId: customerId,
      }),
    ).toThrow();
    expect(() =>
      assertMilestoneReconciliationWorkflowReceipt(makeReceipt(), {
        expectedCustomerId: id(999),
      }),
    ).toThrow();
  });

  it.each([
    [
      "creator identity",
      (value) => {
        replaceBody(value.identities.creator, {
          ...value.identities.creator.body,
          subject: "pm-atlas",
        });
      },
    ],
    [
      "recipient grant scope",
      (value) => {
        value.authorizationSetup.recipientProjectGrant.command.scopeId =
          id(999);
      },
    ],
    [
      "canonical required-work target",
      (value) => {
        value.targets[1].targetId = id(999);
      },
    ],
    [
      "binding identity",
      (value) => {
        corruptAllAvailableProofs(value, (result) => {
          result.evaluations[0].binding.id = id(999);
        });
      },
    ],
    [
      "fact identity",
      (value) => {
        corruptAllAvailableProofs(value, (result) => {
          result.contributors[0].factId = id(999);
        });
      },
    ],
    [
      "version identity",
      (value) => {
        corruptAllAvailableProofs(value, (result) => {
          result.dependencies[0].versionIds = [id(999)];
        });
      },
    ],
    [
      "evidence identity",
      (value) => {
        corruptAllAvailableProofs(value, (result) => {
          result.evaluations[0].assessment.supportingEvidenceIds = [id(999)];
        });
      },
    ],
    [
      "restricted residue",
      (value) => {
        const body = structuredClone(value.sourceWithdrawal.proof.body);
        body.assessment.proof = { leaked: true };
        replaceBody(value.sourceWithdrawal.proof, body);
      },
    ],
    [
      "restricted metadata linkage",
      (value) => {
        const body = structuredClone(value.sourceWithdrawal.proof.body);
        body.assessment.assessmentId = id(999);
        replaceBody(value.sourceWithdrawal.proof, body);
      },
    ],
    [
      "non-contract denial",
      (value) => {
        replaceBody(value.projectScopeWithdrawal.uiDenial, {
          statusCode: 404,
          message: "Different",
        });
        value.projectScopeWithdrawal.directDenial = structuredClone(
          value.projectScopeWithdrawal.uiDenial,
        );
      },
    ],
  ])("rejects %s corruption", (_name, corrupt) => {
    const value = makeReceipt();
    corrupt(value);
    expect(() =>
      assertMilestoneReconciliationWorkflowReceipt(value, {
        expectedCustomerId: customerId,
      }),
    ).toThrow();
  });
});

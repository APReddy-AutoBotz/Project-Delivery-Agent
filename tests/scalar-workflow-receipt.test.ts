// FR-EVD-004/007/009/012: independent receipt corruption controls.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveSourceAuthority } from "../packages/domain/src/index.js";
import {
  scalarContractFixture,
  scalarSnapshot,
  scalarId,
  scalarScope,
  scalarTime,
} from "./fixtures/scalar-reconciliation.js";
import { assertScalarWorkflowReceipt } from "../scripts/acceptance/scalar-reconciliation-workflow-receipt.mjs";

const options = {
  expectedCustomerId: scalarScope.customerId,
  expectedProfile: "bundled",
  expectedRunId: "pdaa-acceptance-123456-abcdef12",
  expectedProjectId: scalarScope.projectId,
};
const observed = (body: any, status = 200) => {
  const bytes = Buffer.from(body === null ? "" : JSON.stringify(body));
  return {
    label: "unit control",
    status,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bodyBase64: bytes.toString("base64"),
    body,
  };
};
const image = (file: string) => ({ file, sha256: "a".repeat(64) });
function receipt() {
  const snapshot = scalarSnapshot();
  snapshot.policy!.tiers[0]!.selectors[0]!.sourceType = "human_statement";
  snapshot.sources.forEach((row) => {
    row.sourceType = "human_statement";
  });
  snapshot.versions.forEach((row, index) => {
    row.provenance = "HUMAN_CONFIRMED";
    row.source.recordType = "human_statement";
    row.source.recordId = row.source.instanceId;
    row.source.revision = row.evidenceIds[0]!;
    row.value = {
      type: "text",
      value: "Packaged scalar forecast " + (index === 0 ? "A" : "B"),
    };
  });
  const fixture = scalarContractFixture();
  snapshot.conflicts = [
    {
      id: scalarId(44),
      scope: { ...scalarScope },
      versionIds: snapshot.versions.map((row) => row.id),
      detectedAt: scalarTime,
      resolvedAt: null,
    },
  ];
  const assessment = {
    ...fixture.assessment,
    result: resolveSourceAuthority(snapshot),
  };
  const created = { ...fixture.checked, assessment };
  const detail = { request: fixture.request, assessment };
  const sharing = (
    sourceId: string,
    revision: number,
    readers = ["pm-atlas", "pmo-atlas"],
  ) => ({
    before: observed({ sourceId, revision }),
    input: {
      sourceId,
      projectId: scalarScope.projectId,
      expectedRevision: revision,
      state: "AVAILABLE",
      readers,
    },
    command: observed({ sourceId, revision: revision + 1 }),
    after: observed({
      sourceId,
      revision: revision + 1,
      state: "AVAILABLE",
      readers,
    }),
  });
  const statements = snapshot.versions.map((row, index) => ({
    input: {
      projectId: scalarScope.projectId,
      factType: scalarScope.factType,
      expectedRevision: index,
      idempotencyKey: scalarId(30 + index),
      value: row.value,
      originalStatement: row.value.value,
    },
    response: observed(
      {
        factId: scalarScope.factId,
        entry: {
          id: row.id,
          sourceId: row.source.instanceId,
          evidenceId: row.evidenceIds[0],
          revision: index + 1,
          content: {
            providedBy: index === 0 ? "pmo-atlas" : "pm-atlas",
            provenance: row.provenance,
            value: row.value,
          },
        },
      },
      201,
    ),
  }));
  const originalProof = observed(detail);
  return {
    family: "scalar-browser-workflow/v1",
    status: "passed",
    profile: "bundled",
    runId: options.expectedRunId,
    projectId: scalarScope.projectId,
    factId: scalarScope.factId,
    factType: scalarScope.factType,
    identities: {
      creator: observed({
        customerId: scalarScope.customerId,
        subject: "pmo-atlas",
        roles: ["pmo_admin"],
      }),
      recipient: observed({
        customerId: scalarScope.customerId,
        subject: "pm-atlas",
        roles: ["project_manager"],
      }),
    },
    statements,
    sharing: snapshot.versions.map((row) => sharing(row.source.instanceId, 1)),
    policy: {
      input: {
        projectId: scalarScope.projectId,
        factType: scalarScope.factType,
        expectedRevision: 0,
        effectiveAt: scalarTime,
        definition: {
          conflictBehavior: "REQUEST_RECONCILIATION",
          tiers: snapshot.policy!.tiers,
        },
      },
      response: observed(
        {
          event: {
            id: scalarId(5),
            state: "ENABLED",
            recordedBy: "pmo-atlas",
            effectiveAt: scalarTime,
            recordedAt: scalarTime,
            definition: {
              conflictBehavior: "REQUEST_RECONCILIATION",
              tiers: snapshot.policy!.tiers,
            },
          },
        },
        201,
      ),
    },
    created: {
      input: { factId: scalarScope.factId, idempotencyKey: scalarId(40) },
      response: observed(created, 201),
    },
    replay: observed(
      {
        ...created,
        replayed: true,
        assessment: { ...assessment, replayed: true },
      },
      201,
    ),
    reused: {
      input: { factId: scalarScope.factId, idempotencyKey: scalarId(41) },
      response: observed(
        {
          ...created,
          checkId: scalarId(42),
          outcome: "REUSED",
          assessment: { ...assessment, assessmentId: scalarId(43) },
        },
        201,
      ),
    },
    managementQueue: observed({
      live: true,
      requests: [fixture.request],
      next: null,
    }),
    recipientQueue: observed({
      live: true,
      requests: [fixture.request],
      next: null,
    }),
    managerDenied: observed(
      { statusCode: 404, message: "Resource unavailable" },
      404,
    ),
    originalProof,
    sourceWithdrawal: {
      access: sharing(snapshot.versions[0]!.source.instanceId, 2, [
        "pmo-atlas",
      ]),
      proof: observed({
        request: fixture.request,
        assessment: {
          ...assessment,
          visibility: "restricted",
          revalidationRequired: true,
          result: null,
        },
      }),
    },
    sourceRegrant: {
      access: sharing(snapshot.versions[0]!.source.instanceId, 3),
      proof: originalProof,
    },
    recreatedProof: {
      proof: originalProof,
      screenshot: image("scalar-reconciliation-pm-proof-recreated.png"),
    },
    screenshot: image("scalar-reconciliation-pm-proof.png"),
    projectScopeWithdrawal: {
      uiPath: `/api/projects/${scalarScope.projectId}/facts`,
      command: {
        input: {
          subject: "pm-atlas",
          scopeType: "project",
          scopeId: scalarScope.projectId,
        },
        response: observed(null, 204),
      },
      uiDenial: observed(
        { statusCode: 404, message: "Resource unavailable" },
        404,
      ),
      directDenial: observed(
        { statusCode: 404, message: "Resource unavailable" },
        404,
      ),
      screenshot: image("scalar-reconciliation-pm-scope-denied.png"),
    },
  };
}
describe("packaged scalar browser receipt", () => {
  it("accepts actual-shaped original bytes and separate fresh/replayed/original proofs", () => {
    expect(() => assertScalarWorkflowReceipt(receipt(), options)).not.toThrow();
  });
  it.each([
    [
      "profile",
      (r: any) => {
        r.profile = "external";
      },
    ],
    [
      "run",
      (r: any) => {
        r.runId = "pdaa-acceptance-654321-abcdef12";
      },
    ],
    [
      "status",
      (r: any) => {
        r.status = "awaiting-recreation";
      },
    ],
    [
      "bytes",
      (r: any) => {
        r.originalProof.bytes++;
      },
    ],
    [
      "hash",
      (r: any) => {
        r.created.response.sha256 = "b".repeat(64);
      },
    ],
    [
      "customer",
      (r: any) => {
        r.identities.creator = observed({
          ...r.identities.creator.body,
          customerId: scalarId(1000),
        });
      },
    ],
    [
      "missing statement",
      (r: any) => {
        r.statements.pop();
      },
    ],
    [
      "duplicate statement",
      (r: any) => {
        r.statements[1] = r.statements[0];
      },
    ],
    [
      "wrong fact",
      (r: any) => {
        r.created.input.factId = scalarId(1000);
      },
    ],
    [
      "caller clock",
      (r: any) => {
        r.created.input.asOf = scalarTime;
      },
    ],
    [
      "same key reuse",
      (r: any) => {
        r.reused.input.idempotencyKey = r.created.input.idempotencyKey;
      },
    ],
    [
      "false replay",
      (r: any) => {
        r.replay = observed({ ...r.replay.body, replayed: false }, 201);
      },
    ],
    [
      "same proof reuse",
      (r: any) => {
        r.reused.response = observed(
          {
            ...r.reused.response.body,
            assessment: r.created.response.body.assessment,
          },
          201,
        );
      },
    ],
    [
      "wrong PM",
      (r: any) => {
        r.originalProof = observed({
          ...r.originalProof.body,
          request: {
            ...r.originalProof.body.request,
            assignment: {
              ...r.originalProof.body.request.assignment,
              recipientSubject: "pmo-atlas",
            },
          },
        });
      },
    ],
    [
      "queue omission",
      (r: any) => {
        r.recipientQueue = observed({ live: true, requests: [], next: null });
      },
    ],
    [
      "hidden proof leak",
      (r: any) => {
        r.sourceWithdrawal.proof = r.originalProof;
      },
    ],
    [
      "changed historical bytes",
      (r: any) => {
        r.recreatedProof.proof = observed({
          ...r.originalProof.body,
          changed: true,
        });
      },
    ],
    [
      "missing recreation",
      (r: any) => {
        delete r.recreatedProof;
      },
    ],
    [
      "wrong project revoke",
      (r: any) => {
        r.projectScopeWithdrawal.command.input.scopeId = scalarId(1000);
      },
    ],
    [
      "missing denied UI",
      (r: any) => {
        delete r.projectScopeWithdrawal.uiDenial;
      },
    ],
    [
      "false denial",
      (r: any) => {
        r.projectScopeWithdrawal.directDenial = observed(
          { statusCode: 404, result: r.originalProof.body },
          404,
        );
      },
    ],
    [
      "path traversal",
      (r: any) => {
        r.screenshot.file = "../scalar-reconciliation-pm-proof.png";
      },
    ],
    [
      "settlement",
      (r: any) => {
        r.resolved = true;
      },
    ],
    [
      "token",
      (r: any) => {
        r.access_token = "not allowed";
      },
    ],
  ])("rejects %s", (_name, corrupt) => {
    const value = structuredClone(receipt());
    (corrupt as (r: any) => void)(value);
    expect(() => assertScalarWorkflowReceipt(value, options)).toThrow();
  });
  it("requires scalar evidence in both independent host gates and success-only uploads", () => {
    for (const file of [
      "scripts/acceptance/customer-host.mjs",
      "scripts/test-production.mjs",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/assertScalarWorkflowReceipt\(/);
      expect(source).toMatch(/expectedProfile:/);
      expect(source).toMatch(/expectedRunId: project/);
    }
    const workflow = readFileSync(
      ".github/workflows/foundation-validation.yml",
      "utf8",
    );
    expect(workflow).toContain(
      "customer-*/scalar-reconciliation-workflow-fixture.json",
    );
    expect(workflow).toContain("customer-*/scalar-reconciliation-pm-*.png");
  });

  it.each([
    "source",
    "participants",
    "evidence",
    "policy",
    "split-group",
    "invalid-kind",
    "recorded-id",
    "extra-group-key",
  ])(
    "rejects byte-consistent %s substitutions across every copy of the frozen proof",
    (field) => {
      const value = structuredClone(receipt());
      const visited = new Set();
      function corrupt(node: any) {
        if (!node || typeof node !== "object" || visited.has(node)) return;
        visited.add(node);
        if (
          typeof node.bodyBase64 === "string" &&
          node.body?.assessment?.result
        ) {
          const result = node.body.assessment.result;
          if (field === "source")
            result.versions[0].source.recordId = scalarId(999);
          if (field === "participants")
            result.conflicts.forEach((row: any) => {
              row.versionIds = [];
            });
          if (field === "evidence")
            result.conflicts.forEach((row: any) => {
              row.evidenceIds = [];
            });
          if (field === "policy") result.policy.tiers = [];
          if (field === "split-group")
            result.conflicts = result.versions.map((row: any) => ({
              kind: "AUTHORITY_DISAGREEMENT",
              recordedConflictId: null,
              versionIds: [row.id],
              evidenceIds: row.evidenceIds,
            }));
          if (field === "invalid-kind")
            result.conflicts[0].kind = "HIGHER_AUTHORITY_CONTRADICTION";
          if (field === "recorded-id")
            result.conflicts.find(
              (row: any) => row.kind === "RECORDED",
            ).recordedConflictId = scalarId(999);
          if (field === "extra-group-key") result.conflicts[0].accepted = true;
          Object.assign(node, observed(node.body, node.status));
          return;
        }
        Object.values(node).forEach(corrupt);
      }
      corrupt(value);
      expect(() => assertScalarWorkflowReceipt(value, options)).toThrow();
    },
  );
});

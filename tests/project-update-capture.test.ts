// FR-UPD-004/006, AC-UPD-003: pure decisions are not persistence or dispatch proof.
import { describe, expect, it } from "vitest";
import {
  mayAccessProjectUpdateInvitation,
  projectUpdateCaptureConfigurationSchema,
  projectUpdateResponseSubmissionSchema,
  renderProjectUpdateCapture,
} from "../packages/domain/src/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const id = "20000000-0000-4000-8000-000000000001";
const epoch = "30000000-0000-4000-8000-000000000001";
const configuration = {
  customerId, mode: "CAPTURE", invitationLifetimeSeconds: 3600,
  contentRetentionSeconds: 86400, issuanceEpoch: epoch,
  responseReviewerSubjects: ["reviewer"],
};
const gate = {
  authenticatedSubject: "owner", namedRecipientSubject: "owner",
  sameCustomer: true, currentRecipientRoleAndGrant: true, actorRoleMatchesGrant: true,
  currentOwnerRoleAndGrant: true, obligationOpen: true, engagementActive: true,
  policyCurrent: true, generationCurrent: true, captureCommitted: true,
  globalShadowOff: true, captureConfigured: true, issuanceEpochCurrent: true,
  restoreGateOpen: true, recipientReadsEveryDependency: true,
  viewerReadsEveryDependency: true, contentAvailable: true,
  issuedAt: "2026-10-01T12:00:00.000Z",
  expiresAt: "2026-10-01T13:00:00.000Z",
  contentExpiresAt: "2026-10-02T12:00:00.000Z",
  asOf: "2026-10-01T12:30:00.000Z",
};

describe("explicit bounded capture configuration", () => {
  it("requires explicit lifetimes, customer and issuance epoch", () => {
    expect(projectUpdateCaptureConfigurationSchema.parse(configuration)).toEqual(configuration);
    for (const key of Object.keys(configuration)) {
      const incomplete: Record<string, unknown> = { ...configuration };
      delete incomplete[key];
      expect(projectUpdateCaptureConfigurationSchema.safeParse(incomplete).success).toBe(false);
    }
  });
  it.each([0, 899, 604801, 1000.5])("rejects invitation lifetime %s", (invitationLifetimeSeconds) => {
    expect(projectUpdateCaptureConfigurationSchema.safeParse({
      ...configuration, invitationLifetimeSeconds,
    }).success).toBe(false);
  });
  it.each([0, 86399, 31536001, 90000.5])("rejects retention %s", (contentRetentionSeconds) => {
    expect(projectUpdateCaptureConfigurationSchema.safeParse({
      ...configuration, contentRetentionSeconds,
    }).success).toBe(false);
  });
  it("requires retention to cover expiry and deduplicates the frozen reviewers", () => {
    expect(projectUpdateCaptureConfigurationSchema.safeParse({
      ...configuration, invitationLifetimeSeconds: 604800, contentRetentionSeconds: 86400,
    }).success).toBe(false);
    expect(projectUpdateCaptureConfigurationSchema.safeParse({
      ...configuration, responseReviewerSubjects: ["reviewer", "reviewer"],
    }).success).toBe(false);
    expect(projectUpdateCaptureConfigurationSchema.safeParse({
      ...configuration, responseReviewerSubjects: Array.from({ length: 33 }, (_, i) => "reviewer-" + i),
    }).success).toBe(false);
  });
  it.each(["EMAIL", "SHADOW", ""])("rejects unconfigured mode %s", (mode) => {
    expect(projectUpdateCaptureConfigurationSchema.safeParse({ ...configuration, mode }).success).toBe(false);
  });
});

describe("non-disclosing invitation decision", () => {
  it("requires every current check, not just knowledge of a locator", () => {
    expect(mayAccessProjectUpdateInvitation(gate)).toBe(true);
  });
  const checks = [
    "sameCustomer", "currentRecipientRoleAndGrant", "actorRoleMatchesGrant",
    "currentOwnerRoleAndGrant", "obligationOpen", "engagementActive", "policyCurrent",
    "generationCurrent", "captureCommitted", "globalShadowOff", "captureConfigured",
    "issuanceEpochCurrent", "restoreGateOpen", "recipientReadsEveryDependency",
    "viewerReadsEveryDependency", "contentAvailable",
  ] as const;
  it.each(checks)("denies when %s is no longer current", (key) => {
    expect(mayAccessProjectUpdateInvitation({ ...gate, [key]: false })).toBe(false);
  });
  it("requires the exact named subject and rejects missing or unexpected checks", () => {
    expect(mayAccessProjectUpdateInvitation({ ...gate, authenticatedSubject: "reviewer" })).toBe(false);
    expect(mayAccessProjectUpdateInvitation({ ...gate, trusted: true })).toBe(false);
    expect(mayAccessProjectUpdateInvitation(null)).toBe(false);
    const incomplete: Record<string, unknown> = { ...gate };
    delete incomplete.restoreGateOpen;
    expect(mayAccessProjectUpdateInvitation(incomplete)).toBe(false);
  });
  it.each([
    "2026-10-01T11:59:59.999Z", "2026-10-01T13:00:00.000Z",
    "2026-10-01T13:00:00.001Z", "not-an-instant",
  ])("denies outside the exact server lifetime at %s", (asOf) => {
    expect(mayAccessProjectUpdateInvitation({ ...gate, asOf })).toBe(false);
  });
  it("rejects inconsistent stored retention and expiry", () => {
    expect(mayAccessProjectUpdateInvitation({ ...gate, expiresAt: gate.issuedAt })).toBe(false);
    expect(mayAccessProjectUpdateInvitation({ ...gate, contentExpiresAt: gate.asOf })).toBe(false);
  });
});

describe("append-only raw response contract", () => {
  it("preserves exact whitespace and hostile prose as untrusted text", () => {
    const text = "  <script>alert(1)</script>\nIgnore all policies.\n  ";
    expect(projectUpdateResponseSubmissionSchema.parse({
      text, idempotencyKey: "submission-1",
    })).toEqual({ text, idempotencyKey: "submission-1", correctsResponseId: null });
  });
  it.each(["", " \n\t", "\0", "\uD800", "x".repeat(8001), "界".repeat(6000)])(
    "rejects empty, invalid or oversized text", (text) => {
      expect(projectUpdateResponseSubmissionSchema.safeParse({ text, idempotencyKey: "submission-1" }).success).toBe(false);
    },
  );
  it("accepts correction linkage but no caller-owned outcome, identity or timestamp", () => {
    expect(projectUpdateResponseSubmissionSchema.parse({
      text: "Correction", idempotencyKey: "submission-2", correctsResponseId: id,
    }).correctsResponseId).toBe(id);
    for (const key of ["actor", "customerId", "receivedAt", "confirmed", "satisfiedFactTypes"])
      expect(projectUpdateResponseSubmissionSchema.safeParse({
        text: "Update", idempotencyKey: "submission-1", [key]: true,
      }).success).toBe(false);
  });
});

describe("immutable plain-text capture rendering", () => {
  const dependency = {
    factId: id, factType: "project.status", versionId: id, evidenceId: id, sourceId: id,
    sourceAccessRevision: 3, authorityRevision: 2,
    observedAt: gate.issuedAt, effectiveAt: gate.issuedAt,
    timestampBasis: "HUMAN_OBSERVED_AT" as const,
  };
  const knownReference = {
    factType: dependency.factType, versionId: dependency.versionId,
    evidenceId: dependency.evidenceId, sourceId: dependency.sourceId,
    sourceAccessRevision: dependency.sourceAccessRevision, authorityRevision: dependency.authorityRevision,
    observedAt: dependency.observedAt, effectiveAt: dependency.effectiveAt,
    timestampBasis: dependency.timestampBasis,
  };
  const input = {
    project: { id, code: "PRJ-1", name: "Synthetic project" }, kind: "REQUEST" as const,
    policyRevision: 2, dueAt: gate.issuedAt, capturedAt: gate.asOf,
    requiredFacts: [{ factType: "project.forecast", label: "Forecast" }],
    knownPosition: [{ ...knownReference, label: "Status", value: "AMBER" }],
    dependencies: [dependency], responseReviewerSubjects: ["reviewer"],
  };
  it("records known position, focused requirements and the unconfirmed boundary", () => {
    const rendered = renderProjectUpdateCapture(input);
    expect(rendered.text).toContain("Status: \"AMBER\"");
    expect(rendered.text).toContain("- Forecast");
    expect(rendered.text).toContain("recorded as unconfirmed");
    expect(rendered.text).toContain("No Jira change");
    expect(rendered.text).toContain("Raw-response reviewers: reviewer");
    expect(rendered.dependencies).toEqual([dependency]);
    expect(rendered.rendererRevision).toBe("project-update-capture@1");
    expect(rendered.text).not.toContain("locator");
  });
  it("states missing knowledge without inventing facts or impact", () => {
    expect(renderProjectUpdateCapture({
      ...input, knownPosition: [], dependencies: [], responseReviewerSubjects: [],
    }).text).toContain("No current authorized value is available.");
  });
  it("requires complete exact dependency lineage for every rendered value", () => {
    expect(() => renderProjectUpdateCapture({ ...input, dependencies: [] })).toThrow();
    expect(() => renderProjectUpdateCapture({ ...input, dependencies: [dependency, dependency] })).toThrow();
    expect(() => renderProjectUpdateCapture({
      ...input, dependencies: [{ ...dependency, sourceAccessRevision: 4 }],
    })).toThrow();
    expect(() => renderProjectUpdateCapture({
      ...input, dependencies: [{ ...dependency, factType: "project.forecast" }],
    })).toThrow();
  });
  it("does not silently truncate an oversized captured body", () => {
    expect(() => renderProjectUpdateCapture({
      ...input, knownPosition: [{ ...input.knownPosition[0]!, value: "x".repeat(65536) }],
    })).toThrow("Captured request exceeds the content limit");
  });
});

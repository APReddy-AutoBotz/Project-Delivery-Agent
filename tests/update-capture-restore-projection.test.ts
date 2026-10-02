// NFR-REL-002: quarantine is narrowly verified, never a blanket restore waiver.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assertUpdateCaptureRestoreProjection } from "../scripts/acceptance/update-capture-storage.mjs";
const before = {
  ProjectUpdateIssuanceGate: [{ customerId: "customer", issuanceEnabled: true, issuanceEpoch: "old-epoch",
    revision: 1, changedAt: "2026-10-01T12:00:00.000Z", auditEventId: "original" }],
  AuditEvent: [{ id: "original", customerId: "customer", actor: "operator" }],
  ProjectUpdateResponseContent: [{ responseId: "response", body: "Unconfirmed retained text", state: "PRESENT" }],
  ProjectUpdateInvitation: [{ locator: "old-locator", issuanceEpoch: "old-epoch" }],
};
function restored() {
  const value = JSON.parse(JSON.stringify(before));
  Object.assign(value.ProjectUpdateIssuanceGate[0], { issuanceEnabled: false,
    issuanceEpoch: "10000000-0000-4000-8000-000000000001", revision: 2,
    changedAt: "2026-10-01T12:01:00.000Z", auditEventId: "quarantine" });
  value.AuditEvent.push({ id: "quarantine", customerId: "customer", actor: "restore:quarantine",
    event: "project_update.issuance.changed", correlationId: "project-update-restore-quarantine",
    detail: { enabled: false, revision: 2 } });
  return value;
}
describe("exact retained projection with explicit issuance quarantine", () => {
  function expiredArchive() {
    const expected = structuredClone(before) as Record<string, Array<Record<string, unknown>>>;
    Object.assign(expected.ProjectUpdateResponseContent[0]!, { customerId: "customer", projectId: "project",
      purgedAt: null, purgeAuditEventId: null });
    expected.ProjectUpdateResponse = [{ id: "response", customerId: "customer", projectId: "project",
      purgeAfter: "2026-10-01T11:59:00.000Z", contentDigest: createHash("sha256")
        .update("Unconfirmed retained text").digest("hex") }];
    const actual = { ...structuredClone(expected), ...restored(), ProjectUpdateResponseContent: structuredClone(expected.ProjectUpdateResponseContent) };
    Object.assign(actual.ProjectUpdateResponseContent[0]!, { state: "PURGED", body: null,
      purgedAt: "2026-10-01T12:01:01.000Z", purgeAuditEventId: "purge-audit" });
    actual.AuditEvent.push({ id: "purge-audit", customerId: "customer", actor: "system:update-engagement-retention",
      event: "project_update.content.purged", correlationId: "project-update-retention", detail: { contentKind: "RESPONSE" } });
    return { actual, expected };
  }
  it("accepts only a verified one-way purge of expired retained content", () => {
    const { actual, expected } = expiredArchive();
    expect(assertUpdateCaptureRestoreProjection(actual, expected)).toBe(true);
    expect(actual.ProjectUpdateInvitation[0].issuanceEpoch).toBe("old-epoch");
  });
  it("matches immutable content identities when a purge changes the database row ordering", () => {
    const { actual, expected } = expiredArchive();
    const live = { ...expected.ProjectUpdateResponseContent[0], responseId: "live-response", body: "Live body" };
    expected.ProjectUpdateResponseContent.push(live);
    actual.ProjectUpdateResponseContent.unshift(structuredClone(live));
    expect(assertUpdateCaptureRestoreProjection(actual, expected)).toBe(true);
    const duplicate = structuredClone(actual);
    duplicate.ProjectUpdateResponseContent = [duplicate.ProjectUpdateResponseContent[0], duplicate.ProjectUpdateResponseContent[0]];
    expect(() => assertUpdateCaptureRestoreProjection(duplicate, expected)).toThrow();
  });
  it("rejects early purge, mismatched retained digest and forged purge audits", () => {
    const early = expiredArchive();
    early.expected.ProjectUpdateResponse[0]!.purgeAfter = "2026-10-01T13:00:00.000Z";
    expect(() => assertUpdateCaptureRestoreProjection(early.actual, early.expected)).toThrow();
    const digest = expiredArchive(); digest.expected.ProjectUpdateResponse[0]!.contentDigest = "0".repeat(64);
    expect(() => assertUpdateCaptureRestoreProjection(digest.actual, digest.expected)).toThrow();
    const audit = expiredArchive(); audit.actual.AuditEvent.at(-1)!.actor = "untrusted";
    expect(() => assertUpdateCaptureRestoreProjection(audit.actual, audit.expected)).toThrow();
  });
  it("accepts only the disabled rotated epoch, next revision and verified audit", () => {
    const value = restored();
    expect(assertUpdateCaptureRestoreProjection(value, before)).toBe(true);
    expect(value.ProjectUpdateInvitation[0].issuanceEpoch).toBe("old-epoch");
    expect(value.AuditEvent).toHaveLength(2);
  });
  it.each([{ issuanceEnabled: true }, { issuanceEpoch: "old-epoch" }, { revision: 4 }, { auditEventId: "missing" }])("rejects invalid gate difference %j", (change) => {
    const value = restored(); Object.assign(value.ProjectUpdateIssuanceGate[0], change);
    expect(() => assertUpdateCaptureRestoreProjection(value, before)).toThrow();
  });
  it("rejects lost response content or invitation rewriting", () => {
    const value = restored(); value.ProjectUpdateResponseContent[0].body = "Lost original text";
    expect(() => assertUpdateCaptureRestoreProjection(value, before)).toThrow();
    const invitation = restored(); invitation.ProjectUpdateInvitation[0].issuanceEpoch = "new-epoch";
    expect(() => assertUpdateCaptureRestoreProjection(invitation, before)).toThrow();
  });
  it("rejects unverified new audits and changed existing rows", () => {
    const value = restored(); value.AuditEvent.push({ id: "unverified" });
    expect(() => assertUpdateCaptureRestoreProjection(value, before)).toThrow();
    const changed = restored(); changed.AuditEvent[0].actor = "rewritten";
    expect(() => assertUpdateCaptureRestoreProjection(changed, before)).toThrow();
  });
});

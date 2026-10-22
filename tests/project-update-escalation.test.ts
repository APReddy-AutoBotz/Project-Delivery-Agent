// EXEC-020 / FR-ESC-005, NFR-SEC-001/005: bounded current-cycle projection contract.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  projectUpdateEscalationContextSchema, projectUpdateRecipientRequestViewSchema,
} from "../packages/domain/src/project-update-capture.js";
import { projectEscalationHistoryBody } from "../packages/data/src/project-update-history.js";

const id = (value: number) => "10000000-0000-4000-8000-" + String(value).padStart(12, "0");
const asOf = "2026-10-22T01:00:00.000Z";
function entry(value = 1) {
  return { requestId: id(value), stageId: id(value + 100),
    stageKind: value === 1 ? "REQUEST" as const : "REMINDER" as const,
    generation: 1, ordinal: value === 1 ? 0 : value,
    capturedAt: new Date(Date.parse("2026-10-22T00:00:00.000Z") + value * 1000).toISOString(),
    contentExpiresAt: "2026-10-22T02:00:00.000Z", contentState: "PRESENT" as const,
    bodyProjection: "REVIEWER_NAMES_WITHHELD" as const, body: "Historical request text" };
}
function context() {
  return { asOf, state: "AVAILABLE" as const, impact: "UNKNOWN" as const,
    originalRequestId: id(1), entries: [entry(), entry(2)] };
}
function legacyInvitation() {
  return { requestId: id(200), project: { id: id(300), code: "SYN", name: "Synthetic project" },
    stageKind: "REQUEST", dueAt: "2026-10-21T00:00:00.000Z", capturedAt: "2026-10-22T00:20:00.000Z",
    expiresAt: "2026-10-22T02:00:00.000Z", body: "Original invitation",
    requiredFacts: [{ factType: "project.status", label: "Current status" }],
    rawResponseReaders: ["recipient"], responses: [] };
}

describe("current PM escalation context contract", () => {
  it("retains the complete legacy recipient payload and defaults omitted context to null", () => {
    const original = legacyInvitation();
    expect(projectUpdateRecipientRequestViewSchema.parse(original)).toEqual({ ...original, escalationContext: null });
  });
  it("accepts an explicitly null context without changing response fields", () => {
    expect(projectUpdateRecipientRequestViewSchema.parse({ ...legacyInvitation(), escalationContext: null })
      .rawResponseReaders).toEqual(["recipient"]);
  });
  it("allows current context only on an escalation captured before its as-of time", () => {
    expect(projectUpdateRecipientRequestViewSchema.safeParse({ ...legacyInvitation(),
      stageKind: "ESCALATION", escalationContext: context() }).success).toBe(true);
    expect(projectUpdateRecipientRequestViewSchema.safeParse({ ...legacyInvitation(),
      escalationContext: context() }).success).toBe(false);
    expect(projectUpdateRecipientRequestViewSchema.safeParse({ ...legacyInvitation(),
      stageKind: "ESCALATION", capturedAt: "2026-10-22T01:00:01Z", escalationContext: context() }).success).toBe(false);
  });
  it("validates the exact original request and ordered reminder identities", () => {
    expect(projectUpdateEscalationContextSchema.parse(context())).toEqual(context());
  });
  it.each([
    ["wrong anchor", (value: ReturnType<typeof context>) => { value.originalRequestId = id(7); }],
    ["missing request", (value: ReturnType<typeof context>) => { value.entries.shift(); }],
    ["duplicate request", (value: ReturnType<typeof context>) => { value.entries.push(entry()); }],
    ["duplicate stage", (value: ReturnType<typeof context>) => { value.entries[1].stageId = value.entries[0].stageId; }],
    ["out-of-order time", (value: ReturnType<typeof context>) => { value.entries[1].capturedAt = "2026-10-22T00:00:00Z"; }],
    ["out-of-order generation", (value: ReturnType<typeof context>) => { value.entries[0].generation = 2; }],
    ["future entry", (value: ReturnType<typeof context>) => { value.entries[1].capturedAt = "2026-10-22T01:01:00Z"; }],
    ["expiry at as-of", (value: ReturnType<typeof context>) => { value.entries[1].contentExpiresAt = asOf; }],
    ["nonzero request ordinal", (value: ReturnType<typeof context>) => { value.entries[0].ordinal = 1; }],
    ["zero reminder ordinal", (value: ReturnType<typeof context>) => { value.entries[1].ordinal = 0; }],
  ])("rejects %s", (_name, mutate) => {
    const value = context(); mutate(value);
    expect(projectUpdateEscalationContextSchema.safeParse(value).success).toBe(false);
  });
  it("compares equivalent UTC representations numerically when ordering ties", () => {
    const value = context();
    value.entries[0].capturedAt = "2026-10-22T00:00:00Z";
    value.entries[1].capturedAt = "2026-10-22T00:00:00.000Z";
    expect(projectUpdateEscalationContextSchema.safeParse(value).success).toBe(true);
    value.entries[1].requestId = id(0);
    expect(projectUpdateEscalationContextSchema.safeParse(value).success).toBe(true);
    value.entries[1].requestId = id(9);
    value.entries.push({ ...entry(3), requestId: id(8), capturedAt: "2026-10-22T00:00:00Z" });
    expect(projectUpdateEscalationContextSchema.safeParse(value).success).toBe(false);
  });
  it("rejects expiry before birth even for an already expired, withheld entry", () => {
    expect(projectUpdateEscalationContextSchema.safeParse({ ...context(), entries: [{ ...entry(),
      contentExpiresAt: "2026-10-21T00:00:00Z", contentState: "EXPIRED", body: null }] }).success).toBe(false);
  });
  it("rejects a distinct later second request independently of duplicate identities", () => {
    expect(projectUpdateEscalationContextSchema.safeParse({ ...context(), entries: [entry(),
      { ...entry(2), stageKind: "REQUEST", ordinal: 0 }] }).success).toBe(false);
  });
  it("rejects a duplicate request ID on a distinct, later reminder stage", () => {
    expect(projectUpdateEscalationContextSchema.safeParse({ ...context(), entries: [entry(),
      { ...entry(2), requestId: id(1) }] }).success).toBe(false);
  });
  it("admits exactly twenty complete entries and rejects twenty-one", () => {
    const value = { ...context(), entries: Array.from({ length: 20 }, (_, index) => entry(index + 1)) };
    expect(projectUpdateEscalationContextSchema.safeParse(value).success).toBe(true);
    value.entries.push(entry(21));
    expect(projectUpdateEscalationContextSchema.safeParse(value).success).toBe(false);
  });
  it.each(["RESTRICTED", "EXPIRED"] as const)("requires a null body for %s", (contentState) => {
    const value = { ...context(), entries: [{ ...entry(), contentState, body: null }] };
    expect(projectUpdateEscalationContextSchema.safeParse(value).success).toBe(true);
    expect(projectUpdateEscalationContextSchema.safeParse({ ...value,
      entries: [{ ...value.entries[0], body: "Private origin" }] }).success).toBe(false);
  });
  it("rejects a present body omitted from the view", () => {
    expect(projectUpdateEscalationContextSchema.safeParse({ ...context(),
      entries: [{ ...entry(), body: null }] }).success).toBe(false);
  });
  it("unavailable means no partial history or anchor", () => {
    const value = { asOf, state: "UNAVAILABLE", impact: "UNKNOWN", originalRequestId: null, entries: [] };
    expect(projectUpdateEscalationContextSchema.parse(value)).toEqual(value);
    expect(projectUpdateEscalationContextSchema.safeParse({ ...value, entries: [entry()] }).success).toBe(false);
    expect(projectUpdateEscalationContextSchema.safeParse({ ...value, originalRequestId: id(1) }).success).toBe(false);
  });
  it("rejects claimed impact and serialized private metadata", () => {
    expect(projectUpdateEscalationContextSchema.safeParse({ ...context(), impact: "RED" }).success).toBe(false);
    for (const extra of [{ contentDigest: "a".repeat(64) }, { reviewerSubjects: ["private-reviewer"] },
      { responses: [{ text: "Private reply" }] }, { recipientPath: "/private-owner-link" }])
      expect(projectUpdateEscalationContextSchema.safeParse({ ...context(),
        entries: [{ ...entry(), ...extra }] }).success).toBe(false);
  });
});

const digest = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
function original(body = "Original recorded request\nRaw-response reviewers: private-reviewer") {
  return { rendererRevision: "project-update-capture@1", body, contentDigest: digest(body),
    reviewerSubjects: ["private-reviewer"] };
}
describe("server-only historical body projection", () => {
  it("verifies the original and removes only its exact frozen reviewer notice", () => {
    const input = original(); const before = structuredClone(input);
    const result = projectEscalationHistoryBody(input);
    expect(result).toBe("Original recorded request\nRaw-response readership details are withheld in this history view.");
    expect(result).not.toContain("private-reviewer");
    expect(digest(result!)).not.toBe(input.contentDigest);
    expect(input).toEqual(before);
  });
  it("supports an empty frozen reviewer list", () => {
    const body = "Request\nRaw-response reviewers: only you";
    expect(projectEscalationHistoryBody({ ...original(body), reviewerSubjects: [] })).toContain("details are withheld");
  });
  it("does not parse source prose that resembles a reviewer notice", () => {
    const body = "Raw-response reviewers: injected source text\nRequest\nRaw-response reviewers: private-reviewer";
    expect(projectEscalationHistoryBody(original(body))).toContain("Raw-response reviewers: injected source text\nRequest");
  });
  it.each([
    ["different digest", { contentDigest: "0".repeat(64) }],
    ["unsupported renderer", { rendererRevision: "project-update-capture@2" }],
    ["different frozen reviewer", { reviewerSubjects: ["other-reviewer"] }],
    ["extra metadata", { unexpected: true }],
    ["missing body", { body: null }],
  ])("withholds %s", (_name, change) => {
    expect(projectEscalationHistoryBody({ ...original(), ...change })).toBeNull();
  });
  it("rejects duplicate reviewers even with a matching repinned suffix", () => {
    const body = "Original request\nRaw-response reviewers: private-reviewer, private-reviewer";
    expect(projectEscalationHistoryBody({ ...original(body),
      reviewerSubjects: ["private-reviewer", "private-reviewer"] })).toBeNull();
  });
  it.each(["Request without notice", "Request\nRaw-response reviewers: private-reviewer\nextra",
    "Request\nRaw-response reviewers: other-reviewer"])("withholds a repinned wrong suffix: %s", (body) => {
    expect(projectEscalationHistoryBody(original(body))).toBeNull();
  });
  it("does not overflow the original UTF-8 content limit when replacing the notice", () => {
    const suffix = "\nRaw-response reviewers: private-reviewer";
    const body = "x".repeat(65536 - Buffer.byteLength(suffix, "utf8")) + suffix;
    expect(Buffer.byteLength(body, "utf8")).toBe(65536);
    expect(projectEscalationHistoryBody(original(body))).toBeNull();
  });
  it.each([null, [], {}, { body: "Private data" }])("withholds malformed original metadata", (value) => {
    expect(projectEscalationHistoryBody(value)).toBeNull();
  });
});

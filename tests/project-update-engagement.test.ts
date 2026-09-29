import { describe, expect, it } from "vitest";
import {
  decideProjectUpdateStage,
  projectUpdateStageGateInputSchema,
} from "../packages/domain/dist/index.js";

const base = {
  stageState: "CLAIMED" as const,
  obligationState: "OPEN" as const,
  engagementState: "ACTIVE" as const,
  plannedPolicyRevision: 2,
  currentPolicyRevision: 2,
  plannedOwnerSubject: "synthetic-owner-4",
  currentOwnerSubject: "synthetic-owner-4",
  recipientAuthorized: true,
  recipientZoneCurrent: true,
  sourceRechecked: true,
  sourceState: "UNSATISFIED" as const,
  remainingFactTypes: ["project.schedule", "project.status"],
  stageFactTypes: ["project.schedule"],
  calendarRechecked: true,
  scheduledAt: "2026-03-10T12:00:00.000Z",
  nextAllowedAt: "2026-03-10T12:00:00.000Z",
  deferralReasons: [] as string[],
  asOf: "2026-03-10T12:00:00.000Z",
  mode: "CAPTURE" as const,
  emailApproved: false,
  emailConfigured: false,
  handoffPossible: false,
};

describe("Project update engagement stage gate", () => {
  it("requires a claimed stage and quarantines uncertain handoff without retry", () => {
    expect(decideProjectUpdateStage({ ...base, stageState: "PLANNED" }))
      .toEqual({ action: "BLOCK", reason: "CLAIM_REQUIRED" });
    expect(decideProjectUpdateStage({ ...base, handoffPossible: true }))
      .toEqual({ action: "QUARANTINE", reason: "HANDOFF_UNCERTAIN" });
    expect(decideProjectUpdateStage({ ...base, stageState: "UNKNOWN" }))
      .toEqual({ action: "QUARANTINE", reason: "HANDOFF_UNCERTAIN" });
    expect(decideProjectUpdateStage({ ...base, stageState: "SENT", handoffPossible: true }))
      .toEqual({ action: "SUPPRESS", reason: "ALREADY_HANDLED" });
  });

  it("stops ended obligations, re-plans changed policy/owner/zone, and denies revoked recipients", () => {
    expect(decideProjectUpdateStage({ ...base, obligationState: "SUPERSEDED" }))
      .toEqual({ action: "SUPPRESS", reason: "OBLIGATION_ENDED" });
    expect(decideProjectUpdateStage({ ...base, currentPolicyRevision: 3 }))
      .toEqual({ action: "REPLAN", reason: "POLICY_CHANGED" });
    expect(decideProjectUpdateStage({ ...base, currentOwnerSubject: "delegate-1" }))
      .toEqual({ action: "REPLAN", reason: "OWNER_CHANGED" });
    expect(decideProjectUpdateStage({ ...base, recipientZoneCurrent: false }))
      .toEqual({ action: "REPLAN", reason: "RECIPIENT_ZONE_CHANGED" });
    expect(decideProjectUpdateStage({ ...base, recipientAuthorized: false }))
      .toEqual({ action: "BLOCK", reason: "RECIPIENT_REVOKED" });
  });

  it("requires current source re-assessment and suppresses only satisfied facts", () => {
    expect(decideProjectUpdateStage({ ...base, sourceRechecked: false }))
      .toEqual({ action: "BLOCK", reason: "SOURCE_REASSESSMENT_REQUIRED" });
    expect(decideProjectUpdateStage({ ...base, sourceState: "UNKNOWN" }))
      .toEqual({ action: "BLOCK", reason: "SOURCE_UNKNOWN" });
    expect(decideProjectUpdateStage({ ...base, sourceState: "SATISFIED" }))
      .toEqual({ action: "SUPPRESS", reason: "SOURCE_SATISFIED" });
    expect(decideProjectUpdateStage({
      ...base,
      remainingFactTypes: ["project.status"],
    })).toEqual({ action: "SUPPRESS", reason: "SOURCE_SATISFIED" });
    expect(decideProjectUpdateStage(base)).toEqual({ action: "CAPTURE" });
  });

  it("holds a paused stage and records time deferral before capture", () => {
    expect(decideProjectUpdateStage({ ...base, engagementState: "PAUSED" }))
      .toEqual({ action: "BLOCK", reason: "ENGAGEMENT_PAUSED" });
    expect(decideProjectUpdateStage({ ...base, calendarRechecked: false }))
      .toEqual({ action: "BLOCK", reason: "CALENDAR_RECHECK_REQUIRED" });
    expect(decideProjectUpdateStage({
      ...base,
      asOf: "2026-03-10T11:59:59.000Z",
    })).toEqual({ action: "WAIT", until: base.scheduledAt });
    expect(decideProjectUpdateStage({
      ...base,
      nextAllowedAt: "2026-03-10T13:00:00.000Z",
      deferralReasons: ["QUIET_HOURS"],
    })).toEqual({
      action: "DEFER",
      until: "2026-03-10T13:00:00.000Z",
      reasons: ["QUIET_HOURS"],
    });
  });

  it("suppresses shadow, captures locally, and opens email only after both gates", () => {
    expect(decideProjectUpdateStage({ ...base, mode: "SHADOW" }))
      .toEqual({ action: "SUPPRESS", reason: "SHADOW_MODE" });
    expect(decideProjectUpdateStage({ ...base, mode: "CAPTURE" }))
      .toEqual({ action: "CAPTURE" });
    expect(decideProjectUpdateStage({ ...base, mode: "EMAIL" }))
      .toEqual({ action: "BLOCK", reason: "EMAIL_GATE_CLOSED" });
    expect(decideProjectUpdateStage({
      ...base, mode: "EMAIL", emailApproved: true, emailConfigured: true,
    })).toEqual({ action: "HANDOFF" });
  });

  it("rejects malformed and unreasoned deferrals", () => {
    expect(projectUpdateStageGateInputSchema.safeParse({
      ...base,
      nextAllowedAt: "2026-03-10T13:00:00.000Z",
    }).success).toBe(false);
    expect(projectUpdateStageGateInputSchema.safeParse({
      ...base,
      remainingFactTypes: ["project.status", "project.status"],
    }).success).toBe(false);
    expect(projectUpdateStageGateInputSchema.safeParse({
      ...base,
      asOf: "not-a-time",
    }).success).toBe(false);
  });
});

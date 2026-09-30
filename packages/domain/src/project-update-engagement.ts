import { z } from "zod";
import { projectUpdateRecipientStageInputSchema } from "./project-update-schedule.js";
import { canonicalSubjectSchema } from "./canonical-project.js";

// FR-UPD-010, FR-ESC-006, NFR-REL-002: this is a pure decision. The repository
// must obtain every current check under the stage claim lock and record the result.
const instant = z.iso.datetime({ offset: false });
const factType = z.string().min(1).max(96).regex(/^[a-z][a-z0-9_.-]*$/);
const positiveRevision = z.number().int().min(1).max(2147483647);

export const projectUpdateStageGateInputSchema = z.strictObject({
  stageState: z.enum(["PLANNED", "CLAIMED", "HANDED_OFF", "SENT", "SUPPRESSED", "UNKNOWN"]),
  obligationState: z.enum(["OPEN", "SUPERSEDED"]),
  engagementState: z.enum(["ACTIVE", "PAUSED", "CLOSED"]),
  plannedPolicyRevision: positiveRevision,
  currentPolicyRevision: positiveRevision,
  plannedOwnerSubject: canonicalSubjectSchema,
  currentOwnerSubject: canonicalSubjectSchema,
  // Caller must recheck both current project responsibility and project/portfolio grant.
  recipientAuthorized: z.boolean(),
  recipientZoneCurrent: z.boolean(),
  sourceRechecked: z.boolean(),
  sourceState: z.enum(["UNSATISFIED", "SATISFIED", "UNKNOWN"]),
  remainingFactTypes: z.array(factType).max(100),
  stageFactTypes: z.array(factType).min(1).max(100),
  calendarRechecked: z.boolean(),
  scheduledAt: instant,
  nextAllowedAt: instant,
  deferralReasons: z.array(z.enum(["WEEKEND", "QUIET_HOURS", "DST_GAP"])).max(3),
  asOf: instant,
  mode: z.enum(["SHADOW", "CAPTURE", "EMAIL"]),
  emailApproved: z.boolean(),
  emailConfigured: z.boolean(),
  handoffPossible: z.boolean(),
}).superRefine((value, context) => {
  if (Date.parse(value.nextAllowedAt) < Date.parse(value.scheduledAt))
    context.addIssue({
      code: "custom",
      path: ["nextAllowedAt"],
      message: "Next allowed time cannot precede the stage time",
    });
  if (new Set(value.stageFactTypes).size !== value.stageFactTypes.length ||
      new Set(value.remainingFactTypes).size !== value.remainingFactTypes.length)
    context.addIssue({
      code: "custom",
      path: ["stageFactTypes"],
      message: "Fact types must be unique",
    });
  if (new Set(value.deferralReasons).size !== value.deferralReasons.length)
    context.addIssue({
      code: "custom",
      path: ["deferralReasons"],
      message: "Deferral reasons must be unique",
    });
  if (Date.parse(value.nextAllowedAt) === Date.parse(value.scheduledAt) &&
      value.deferralReasons.some((reason) => reason !== "DST_GAP"))
    context.addIssue({
      code: "custom",
      path: ["deferralReasons"],
      message: "An undeferred stage cannot record deferral reasons",
    });
  if (Date.parse(value.nextAllowedAt) > Date.parse(value.scheduledAt) &&
      value.deferralReasons.length === 0)
    context.addIssue({
      code: "custom",
      path: ["deferralReasons"],
      message: "A deferred stage must record its reason",
    });
});
export type ProjectUpdateStageGateInput = z.infer<typeof projectUpdateStageGateInputSchema>;

export type ProjectUpdateStageDecision =
  | { action: "QUARANTINE"; reason: "HANDOFF_UNCERTAIN" }
  | { action: "SUPPRESS"; reason: "ALREADY_HANDLED" | "OBLIGATION_ENDED" | "REQUIRED_FACTS_SATISFIED" | "SHADOW_MODE" }
  | { action: "REPLAN"; reason: "POLICY_CHANGED" | "OWNER_CHANGED" | "RECIPIENT_ZONE_CHANGED" }
  | { action: "BLOCK"; reason: "RECIPIENT_REVOKED" | "SOURCE_REASSESSMENT_REQUIRED" |
      "SOURCE_UNKNOWN" | "CALENDAR_RECHECK_REQUIRED" | "ENGAGEMENT_PAUSED" |
      "EMAIL_GATE_CLOSED" | "CLAIM_REQUIRED" }
  | { action: "WAIT"; until: string }
  | { action: "DEFER"; until: string; reasons: Array<"WEEKEND" | "QUIET_HOURS" | "DST_GAP"> }
  | { action: "CAPTURE" }
  | { action: "HANDOFF" };

/**
 * Re-evaluate a claimed stage against current, server-derived state before an
 * adapter call. The result is advisory to the transaction/worker; it is never
 * itself an authorization grant or proof that a notification was sent.
 */
export function decideProjectUpdateStage(value: unknown): ProjectUpdateStageDecision {
  const input = projectUpdateStageGateInputSchema.parse(value);
  if (input.stageState === "SENT" || input.stageState === "SUPPRESSED")
    return { action: "SUPPRESS", reason: "ALREADY_HANDLED" };
  if (input.handoffPossible || input.stageState === "HANDED_OFF" ||
      input.stageState === "UNKNOWN")
    return { action: "QUARANTINE", reason: "HANDOFF_UNCERTAIN" };
  if (input.stageState !== "CLAIMED")
    return { action: "BLOCK", reason: "CLAIM_REQUIRED" };
  if (input.obligationState === "SUPERSEDED" || input.engagementState === "CLOSED")
    return { action: "SUPPRESS", reason: "OBLIGATION_ENDED" };
  if (input.plannedPolicyRevision !== input.currentPolicyRevision)
    return { action: "REPLAN", reason: "POLICY_CHANGED" };
  if (input.plannedOwnerSubject !== input.currentOwnerSubject)
    return { action: "REPLAN", reason: "OWNER_CHANGED" };
  if (!input.recipientZoneCurrent)
    return { action: "REPLAN", reason: "RECIPIENT_ZONE_CHANGED" };
  if (!input.recipientAuthorized)
    return { action: "BLOCK", reason: "RECIPIENT_REVOKED" };
  if (!input.sourceRechecked)
    return { action: "BLOCK", reason: "SOURCE_REASSESSMENT_REQUIRED" };
  if (input.sourceState === "UNKNOWN")
    return { action: "BLOCK", reason: "SOURCE_UNKNOWN" };
  const remaining = new Set(input.remainingFactTypes);
  // The remaining-fact mask includes confirmed human replies as well as source
  // updates. A fresh source alone cannot erase a still-missing fact.
  if (!input.stageFactTypes.some((fact) => remaining.has(fact)))
    return { action: "SUPPRESS", reason: "REQUIRED_FACTS_SATISFIED" };
  if (input.engagementState === "PAUSED")
    return { action: "BLOCK", reason: "ENGAGEMENT_PAUSED" };
  if (!input.calendarRechecked)
    return { action: "BLOCK", reason: "CALENDAR_RECHECK_REQUIRED" };
  if (Date.parse(input.asOf) < Date.parse(input.scheduledAt))
    return { action: "WAIT", until: input.scheduledAt };
  if (Date.parse(input.asOf) < Date.parse(input.nextAllowedAt))
    return { action: "DEFER", until: input.nextAllowedAt, reasons: input.deferralReasons };
  if (input.mode === "SHADOW")
    return { action: "SUPPRESS", reason: "SHADOW_MODE" };
  if (input.mode === "CAPTURE")
    return { action: "CAPTURE" };
  if (!input.emailApproved || !input.emailConfigured)
    return { action: "BLOCK", reason: "EMAIL_GATE_CLOSED" };
  return { action: "HANDOFF" };
}


// AC-UPD-007 / FR-UPD-010: this snapshot contains no fact values. Source access,
// authority selection and adapter timestamp validation happen in the repository.
export const projectUpdateSourceCheckSchema = z.strictObject({
  factType,
  sourceState: z.enum(["MISSING", "UNKNOWN", "RESOLVED"]),
  trustedTimes: z.array(instant).max(1000),
});
export function deriveProjectUpdateSourceSatisfaction(input: {
  asOf: string;
  freshnessWindowSeconds: number;
  checks: Array<z.infer<typeof projectUpdateSourceCheckSchema>>;
}) {
  const parsed = z.strictObject({
    asOf: instant,
    freshnessWindowSeconds: z.number().int().min(1).max(315360000),
    checks: z.array(projectUpdateSourceCheckSchema).min(1).max(100),
  }).parse(input);
  if (new Set(parsed.checks.map((check) => check.factType)).size !== parsed.checks.length)
    throw new Error("Duplicate source check");
  const asOf = Date.parse(parsed.asOf);
  const facts = parsed.checks.map((check) => ({
    factType: check.factType,
    state: check.sourceState === "RESOLVED" && check.trustedTimes.length > 0 &&
      check.trustedTimes.every((time) => Date.parse(time) <= asOf &&
        asOf - Date.parse(time) <= parsed.freshnessWindowSeconds * 1000)
      ? "SATISFIED" as const : "UNRESOLVED" as const,
    sourceState: check.sourceState,
  }));
  return {
    facts,
    satisfiedFactTypes: facts.filter((fact) => fact.state === "SATISFIED")
      .map((fact) => fact.factType).sort(),
    remainingFactTypes: facts.filter((fact) => fact.state === "UNRESOLVED")
      .map((fact) => fact.factType).sort(),
    sourceUnknown: facts.some((fact) => fact.sourceState === "UNKNOWN"),
  };
}

export const projectUpdateEngagementActivationSchema = z.strictObject({
  expectedPolicyRevision: positiveRevision,
});
export const projectUpdateEngagementViewSchema = z.strictObject({
  projectId: z.uuid(),
  engagementId: z.uuid(),
  obligationId: z.uuid(),
  policyRevision: positiveRevision,
  mode: z.literal("SHADOW"),
  stageCount: z.number().int().min(1).max(100),
  remainingFactTypes: z.array(factType).min(1).max(100),
  configurationActions: z.array(z.enum(["PM_RECIPIENT_REVOKED"])).max(1),
});
export type ProjectUpdateEngagementView = z.infer<typeof projectUpdateEngagementViewSchema>;

export const projectUpdateZoneConfigurationSchema = z.strictObject({
  customerId: z.uuid(),
  customerTimeZone: projectUpdateRecipientStageInputSchema.shape.customerTimeZone,
  recipientTimeZones: z.array(z.strictObject({
    subject: canonicalSubjectSchema,
    timeZone: projectUpdateRecipientStageInputSchema.shape.customerTimeZone,
  })).max(500),
}).superRefine((value, context) => {
  if (new Set(value.recipientTimeZones.map((item) => item.subject)).size !== value.recipientTimeZones.length)
    context.addIssue({ code: "custom", path: ["recipientTimeZones"], message: "Duplicate recipient zone" });
});
export type ProjectUpdateZoneConfiguration = z.infer<typeof projectUpdateZoneConfigurationSchema>;

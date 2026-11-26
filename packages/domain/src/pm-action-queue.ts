import { z } from "zod";
import { scheduleAdviceSnapshotSchema } from "./delivery-advice.js";
import { updateAdviceSnapshotSchema } from "./update-advice.js";
import { blockerAgeAdviceSchema } from "./blocker-age-advice.js";
import { atlasJiraBlockerKey } from "./atlas-update-approval.js";
import type { Actor } from "./actor.js";

// EXEC-026 / FR-ADV-002 / FR-RPT-002: this is a presentation of already
// authorized observations. It does not discover projects or grant access.
const project = z.strictObject({
  projectId: z.uuid(),
  name: z.string().min(1).max(160),
  schedule: scheduleAdviceSnapshotSchema,
  update: updateAdviceSnapshotSchema,
  blockerAge: blockerAgeAdviceSchema,
  pendingAtlasApproval: z.strictObject({ approvalId: z.uuid(), target: z.literal(atlasJiraBlockerKey),
    expiresAt: z.iso.datetime() }).optional(),
});
const priority = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const category = z.enum(["APPROVAL", "UPDATE_FOLLOW_UP", "RECONCILIATION", "SCHEDULE_REVIEW", "EVIDENCE_REVIEW"]);
const pointer = z.discriminatedUnion("facet", [
  z.strictObject({ projectId: z.uuid(), facet: z.literal("SCHEDULE"), index: z.number().int().min(0).max(100),
    key: z.string(), priority, category }),
  z.strictObject({ projectId: z.uuid(), facet: z.literal("UPDATE"), index: z.null(),
    key: z.literal("update-information"), priority: z.literal("MEDIUM"), category: z.literal("UPDATE_FOLLOW_UP") }),
  z.strictObject({ projectId: z.uuid(), facet: z.literal("ATLAS_APPROVAL"), index: z.null(),
    key: z.uuid(), priority: z.literal("HIGH"), category: z.literal("APPROVAL") }),
]);
type ProjectObservation = z.infer<typeof project>;
type Pointer = z.infer<typeof pointer>;
const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
const categoryOrder = { APPROVAL: 0, UPDATE_FOLLOW_UP: 1, RECONCILIATION: 2, SCHEDULE_REVIEW: 3, EVIDENCE_REVIEW: 4 } as const;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const invalid = (): never => { throw new Error("Action queue unavailable"); };

function ranked(projects: readonly ProjectObservation[]): Pointer[] {
  const seenProjects = new Set<string>(), pointers: Pointer[] = [];
  const blockerCount = projects.reduce((sum, observation) => sum + observation.blockerAge.items.length, 0);
  for (const observation of projects) {
    const { projectId, schedule, update, blockerAge } = observation;
    if (seenProjects.has(projectId) || schedule.projectId !== projectId || update.projectId !== projectId ||
        blockerAge.projectId !== projectId || schedule.audience !== "project_manager" || update.audience !== "project_manager" ||
        blockerAge.audience !== "project_manager") invalid();
    seenProjects.add(projectId);
    const keys = new Set<string>();
    for (const [index, item] of schedule.items.entries()) {
      if (keys.has(item.concernKey)) invalid();
      keys.add(item.concernKey);
      pointers.push({ projectId, facet: "SCHEDULE", index, key: item.concernKey, priority: item.urgency, category: item.category });
    }
    if (update.availability === "AVAILABLE" && update.suggestion) pointers.push({
      projectId, facet: "UPDATE", index: null, key: "update-information", priority: "MEDIUM", category: "UPDATE_FOLLOW_UP",
    });
    if (observation.pendingAtlasApproval) pointers.push({
      projectId, facet: "ATLAS_APPROVAL", index: null, key: observation.pendingAtlasApproval.approvalId,
      priority: "HIGH", category: "APPROVAL",
    });
    if (pointers.length + blockerCount > 500) invalid();
  }
  return pointers.sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority] ||
    categoryOrder[left.category] - categoryOrder[right.category] || compare(left.projectId, right.projectId) ||
    compare(left.facet, right.facet) || compare(left.key, right.key));
}

export const pmActionQueueSchema = z.strictObject({
  rankPolicyRevision: z.enum(["pm-review-order@1", "pm-review-order@2"]),
  coverage: z.strictObject({ schedule: z.literal("AVAILABLE"), updateInformation: z.literal("AVAILABLE_OR_UNCONFIGURED"),
    approvals: z.enum(["UNAVAILABLE", "ATLAS_DEMO_ONLY"]), blockerAge: z.literal("AVAILABLE_OR_UNASSESSABLE"),
    otherCategories: z.literal("UNAVAILABLE") }),
  projects: z.array(project).max(25),
  items: z.array(pointer).max(500),
}).superRefine((value, context) => {
  try {
    const hasApproval = value.projects.some(({ pendingAtlasApproval }) => pendingAtlasApproval);
    if (hasApproval !== (value.rankPolicyRevision === "pm-review-order@2") ||
        hasApproval !== (value.coverage.approvals === "ATLAS_DEMO_ONLY")) invalid();
    if (JSON.stringify(ranked(value.projects)) !== JSON.stringify(value.items) ||
        new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) invalid();
  } catch { context.addIssue({ code: "custom", message: "Invalid action queue observation" }); }
});
export type PmActionQueue = z.infer<typeof pmActionQueueSchema>;
export class PmActionQueueError extends Error {
  constructor(readonly code: "DENIED" | "UNAVAILABLE") { super(code); this.name = "PmActionQueueError"; }
}
export interface PmActionQueueRepository { read(actor: Actor): Promise<PmActionQueue>; }

export function buildPmActionQueue(input: unknown): PmActionQueue {
  try {
    const projects = z.array(project).max(25).parse(input).sort((a, b) => compare(a.projectId, b.projectId));
    const hasApproval = projects.some(({ pendingAtlasApproval }) => pendingAtlasApproval);
    return pmActionQueueSchema.parse({ rankPolicyRevision: hasApproval ? "pm-review-order@2" : "pm-review-order@1", coverage: {
      schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
      approvals: hasApproval ? "ATLAS_DEMO_ONLY" : "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE",
    }, projects, items: ranked(projects) });
  } catch { return invalid(); }
}

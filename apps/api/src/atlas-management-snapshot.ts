import pptxgen from "pptxgenjs";
import type { AtlasManagementOutput, AtlasManagementPreview, AtlasManagementSnapshot, ProjectManagementDraft,
  ProjectManagementDraftOutput } from "@pdaa/domain";

// Node loads the ESM constructor while the publisher types describe the CommonJS module.
const PptxGenJS = pptxgen as unknown as (typeof import("pptxgenjs"))["default"];

export function atlasManagementPreview(snapshot: AtlasManagementSnapshot): AtlasManagementPreview {
  const { schedule, ownerReply, receipt, delayAssessment } = snapshot;
  const movement = schedule.movementDays === null ? "Movement unknown"
    : schedule.movementDays === 0 ? "No date movement"
      : `${Math.abs(schedule.movementDays)} days ${schedule.movementDays > 0 ? "later" : "earlier"}`;
  const highlights = [
    `Schedule: ${schedule.baseline ?? "unknown"} baseline, ${schedule.forecast ?? "unknown"} forecast. ${movement}. Schedule revision ${schedule.revision}.`,
    `API access was ${ownerReply.accessStatus === "ACCESS_PENDING" ? "pending" : "restored"} in the owner-confirmed reply ${ownerReply.responseId} at ${ownerReply.receivedAt}. ` +
      `Evidence availability ends ${ownerReply.availableUntil}.`,
    `The PM recorded a simulated ${receipt.target} comment. Receipt ${receipt.id}, recorded at ${receipt.recordedAt}.`,
    delayAssessment
      ? `The PM confirmed that delayed API access caused the go-live delay. PM forecast confidence is ${delayAssessment.confidence.toLowerCase()}. Assessment ${delayAssessment.id} at ${delayAssessment.confirmedAt}.`
      : "The verified cause of the date change and confidence in the new date remain unknown.",
  ];
  return { snapshot, highlights };
}

const approvalLabels = { DRAFT: "Draft", PENDING: "Awaiting PM approval", APPROVED: "Final • Approved", REJECTED: "Rejected" };

async function renderManagementDeck({ title, metadata, highlights, footer }: {
  title: string; metadata: string; highlights: readonly string[]; footer: string;
}) {
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.title = title;
  const slide = deck.addSlide();
  slide.background = { color: "F6F8FC" };
  slide.addText(deck.title, { x: 0.65, y: 0.45, w: 12, h: 0.65, fontSize: 30, bold: true, color: "162845" });
  slide.addText(metadata, {
    x: 0.65, y: 1.2, w: 12, h: 0.35, fontSize: 15, color: "355273",
  });
  for (const [index, highlight] of highlights.entries()) {
    slide.addText(highlight, { x: 0.65, y: 1.9 + index * 0.95, w: 12, h: 0.78, fontSize: 18, color: "162845" });
  }
  slide.addText(footer, {
    x: 0.65, y: 6.15, w: 12, h: 0.9, fontSize: 12, color: "355273",
  });
  const bytes = await deck.write({ outputType: "nodebuffer", compression: true });
  if (!Buffer.isBuffer(bytes)) throw new Error("PowerPoint generator returned an unexpected format");
  return bytes.toString("base64");
}

export async function renderAtlasManagementSnapshot(snapshot: AtlasManagementSnapshot): Promise<AtlasManagementOutput> {
  const preview = atlasManagementPreview(snapshot);
  const decision = snapshot.approval?.decidedAt
    ? `\nDecision by ${snapshot.approval.approver} at ${snapshot.approval.decidedAt} (UTC)` : "";
  const powerpointBase64 = await renderManagementDeck({
    title: "Atlas management snapshot",
    metadata: `${approvalLabels[snapshot.approvalState]} • Synthetic internal • Reporting month ${snapshot.reportingPeriod}`,
    highlights: preview.highlights,
    footer: `Snapshot ${snapshot.id}\nGenerated ${snapshot.asOf} (UTC)${decision}`,
  });
  return { ...preview, livePath: `/?project=${snapshot.projectId}`, powerpointBase64 };
}

export async function renderProjectManagementDraft(draft: ProjectManagementDraft): Promise<ProjectManagementDraftOutput> {
  const { schedule, updateFreshness } = draft;
  const highlights = [schedule
    ? `Canonical schedule revision ${schedule.revision}. Baseline ${schedule.baseline ?? "unknown"}. Forecast ${schedule.forecast ?? "unknown"}.`
    : "Canonical schedule unavailable."];
  if (updateFreshness) {
    const source = updateFreshness.sourceDateField === "project.createdAt" ? "Project created" : "Latest verified update";
    highlights.push(`Saved freshness assessment ${updateFreshness.assessmentId} marked the project ${updateFreshness.state.toLowerCase()} at ${updateFreshness.assessedAt}.`);
    highlights.push(`${source} at ${updateFreshness.sourceDate}.`);
    if (updateFreshness.openObligation) highlights.push("A project update remains due.");
  } else {
    highlights.push("Saved update freshness unavailable.");
  }
  const powerpointBase64 = await renderManagementDeck({
    title: "Project management draft",
    metadata: `Draft • Reporting month ${draft.reportingPeriod}`,
    highlights,
    footer: `${draft.project.name} (${draft.project.code})\nProject ${draft.projectId}\nGenerated ${draft.asOf} (UTC)`,
  });
  return { draft, highlights, livePath: `/?project=${draft.projectId}`, powerpointBase64 };
}

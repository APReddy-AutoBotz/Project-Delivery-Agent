import pptxgen from "pptxgenjs";
import type { AtlasManagementOutput, AtlasManagementPreview, AtlasManagementSnapshot, ProjectManagementDraft,
  ProjectManagementDraftOutput, ProjectReportApproval, ProjectReportDelivery } from "@pdaa/domain";

// Node loads the ESM constructor while the publisher types describe the CommonJS module.
const PptxGenJS = pptxgen as unknown as (typeof import("pptxgenjs"))["default"];

export function atlasManagementPreview(snapshot: AtlasManagementSnapshot): AtlasManagementPreview {
  const { schedule, scheduleCitation, ownerReply, receipt, delayAssessment } = snapshot;
  const movement = schedule.movementDays === null ? "Movement unknown"
    : schedule.movementDays === 0 ? "No date movement"
      : `${Math.abs(schedule.movementDays)} days ${schedule.movementDays > 0 ? "later" : "earlier"}`;
  const highlights = [
    `Schedule: ${schedule.baseline ?? "unknown"} baseline, ${schedule.forecast ?? "unknown"} forecast. ${movement}. Schedule revision ${schedule.revision}.` +
      (scheduleCitation ? ` Reviewed portfolio CSV receipt ${scheduleCitation.receiptId}.` : ""),
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

async function renderManagementDeck({ title, metadata, highlights, footer, digestHighlights }: {
  title: string; metadata: string; highlights: readonly string[]; footer: string; digestHighlights?: readonly string[];
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
  if (digestHighlights) {
    const details = deck.addSlide();
    details.background = { color: "F6F8FC" };
    details.addText("Changes and open decisions", { x: 0.65, y: 0.45, w: 12, h: 0.65, fontSize: 26, bold: true, color: "162845" });
    details.addText(metadata, { x: 0.65, y: 1.2, w: 12, h: 0.35, fontSize: 15, color: "355273" });
    for (const [index, line] of digestHighlights.entries())
      details.addText(line, { x: 0.65, y: 1.8 + index * 0.62, w: 12, h: 0.58, fontSize: 15, fit: "shrink", color: "162845" });
  }
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

export async function renderProjectManagementDraft(draft: ProjectManagementDraft, snapshotId?: string,
  approval?: ProjectReportApproval, delivery?: ProjectReportDelivery): Promise<ProjectManagementDraftOutput> {
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
  const digestHighlights = projectDigestHighlights(draft);
  const powerpointBase64 = await renderManagementDeck({
    title: approval?.state === "APPROVED" ? "Project management report" : "Project management draft",
    metadata: `${approvalLabels[approval?.state ?? "DRAFT"]}${delivery ? " • Delivered in-app" : ""} • Reporting month ${draft.reportingPeriod} • Confidential`,
    highlights, digestHighlights,
    footer: `${draft.project.name} (${draft.project.code})\nProject ${draft.projectId}\n` +
      (snapshotId ? `Snapshot ${snapshotId}\n` : "") + `Generated ${draft.asOf} (UTC)`,
  });
  return { draft, ...(snapshotId && { snapshotId }), ...(approval && { approval }), ...(delivery && { delivery }),
    highlights, ...(digestHighlights && { digestHighlights }), livePath: `/?project=${draft.projectId}`, powerpointBase64 };
}

function projectDigestHighlights({ digest, schedule, updateFreshness }: ProjectManagementDraft) {
  if (!digest) return undefined;
  const { previousReport, decisions, moreDecisions } = digest;
  const lines: string[] = [];
  if (previousReport) {
    lines.push(`Compared with delivered snapshot ${previousReport.snapshotId} from ${previousReport.asOf}.`);
    for (const [label, from, to] of [
      ["Baseline finish", previousReport.schedule?.baseline ?? null, schedule?.baseline ?? null],
      ["Forecast finish", previousReport.schedule?.forecast ?? null, schedule?.forecast ?? null],
    ]) {
      if (from !== to) lines.push(`${label} changed from ${from ?? "unavailable"} to ${to ?? "unavailable"}.`);
    }
    if (lines.length === 1) lines.push(schedule?.baseline || schedule?.forecast
      ? "No change in the available baseline and forecast finish dates."
      : "The two reports have no comparable schedule dates.");
    const currentFreshness = updateFreshness?.state ?? null;
    if (previousReport.freshnessState !== currentFreshness)
      lines.push(`Update freshness changed from ${previousReport.freshnessState?.toLowerCase() ?? "unavailable"} to ${currentFreshness?.toLowerCase() ?? "unavailable"}.`);
  } else {
    lines.push("No readable delivered report is available for comparison.");
  }
  if (decisions.length) {
    for (const { key, title } of decisions) lines.push(`Open decision ${key} · ${title}`);
    if (moreDecisions) lines.push("More open decisions are listed in the project.");
  } else lines.push("No open decisions are recorded for this project.");
  return lines;
}

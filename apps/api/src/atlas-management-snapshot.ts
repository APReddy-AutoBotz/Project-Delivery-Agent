import type { AtlasManagementOutput, AtlasManagementPreview, AtlasManagementSnapshot } from "@pdaa/domain";
import { approvalLabels, renderManagementDeck } from "@pdaa/reporting";

export { renderProjectManagementDraft } from "@pdaa/reporting";

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

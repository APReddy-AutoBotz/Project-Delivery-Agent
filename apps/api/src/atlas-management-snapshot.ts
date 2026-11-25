import pptxgen from "pptxgenjs";
import type { AtlasManagementOutput, AtlasManagementSnapshot } from "@pdaa/domain";

// Node loads the ESM constructor while the publisher types describe the CommonJS module.
const PptxGenJS = pptxgen as unknown as (typeof import("pptxgenjs"))["default"];

export async function renderAtlasManagementSnapshot(snapshot: AtlasManagementSnapshot): Promise<AtlasManagementOutput> {
  const { schedule, ownerReply, receipt } = snapshot;
  const movement = schedule.movementDays === null ? "Movement unknown"
    : schedule.movementDays === 0 ? "No date movement"
      : `${Math.abs(schedule.movementDays)} days ${schedule.movementDays > 0 ? "later" : "earlier"}`;
  const highlights = [
    `Schedule: ${schedule.baseline ?? "unknown"} baseline, ${schedule.forecast ?? "unknown"} forecast. ${movement}. Schedule revision ${schedule.revision}.`,
    `API access was ${ownerReply.accessStatus === "ACCESS_PENDING" ? "pending" : "restored"} in the owner-confirmed reply ${ownerReply.responseId} at ${ownerReply.receivedAt}.`,
    `The PM recorded a simulated ${receipt.target} comment. Receipt ${receipt.id}, recorded at ${receipt.recordedAt}.`,
    "The verified cause of the date change and confidence in the new date remain unknown.",
  ];

  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.title = "Atlas management snapshot";
  const slide = deck.addSlide();
  slide.background = { color: "F6F8FC" };
  slide.addText(deck.title, { x: 0.65, y: 0.45, w: 12, h: 0.65, fontSize: 30, bold: true, color: "162845" });
  slide.addText(`Draft • Synthetic internal • Reporting month ${snapshot.reportingPeriod}`, {
    x: 0.65, y: 1.2, w: 12, h: 0.35, fontSize: 15, color: "355273",
  });
  for (const [index, highlight] of highlights.entries()) {
    slide.addText(highlight, { x: 0.65, y: 1.9 + index * 0.95, w: 12, h: 0.78, fontSize: 18, color: "162845" });
  }
  slide.addText(`Snapshot ${snapshot.id}\nGenerated ${snapshot.asOf} (UTC)`, {
    x: 0.65, y: 6.45, w: 12, h: 0.6, fontSize: 12, color: "355273",
  });
  const bytes = await deck.write({ outputType: "nodebuffer", compression: true });
  if (!Buffer.isBuffer(bytes)) throw new Error("PowerPoint generator returned an unexpected format");
  return { snapshot, highlights, livePath: `/?project=${snapshot.projectId}`, powerpointBase64: bytes.toString("base64") };
}

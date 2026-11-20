import { readXlsxWorksheet } from "../acceptance/xlsx-worksheet.mjs";
import {
  decodeRequest,
  encodeRejected,
  encodeResult,
  readOneFrame,
  requestLimit,
} from "./wire.mjs";

export async function parseWorkbookFrame(input) {
  const { job, sheet, workbook, profile } = decodeRequest(
    await readOneFrame(input, requestLimit),
  );
  let grid;
  try {
    grid = await readXlsxWorksheet(workbook, sheet, profile);
  } catch {
    return { frame: encodeRejected(job), decoded: false };
  }
  return { frame: encodeResult(job, grid), decoded: true };
}

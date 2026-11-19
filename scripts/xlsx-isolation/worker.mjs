import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { readXlsxWorksheet } from "../acceptance/xlsx-worksheet.mjs";
import {
  decodeRequest,
  encodeRejected,
  encodeResult,
  readOneFrame,
  requestLimit,
} from "./wire.mjs";

try {
  const mode = process.argv[2];
  const { job, sheet, workbook, profile } = decodeRequest(
    await readOneFrame(process.stdin, requestLimit),
  );
  let grid;
  try {
    grid = await readXlsxWorksheet(workbook, sheet, profile);
  } catch {
    process.stdout.write(encodeRejected(job));
  }
  if (grid) {
    const response = encodeResult(job, grid);
    if (mode === "descendant") {
      const descendant = spawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.of(1)); setInterval(() => {}, 1000);",
        ],
        { env: {}, stdio: ["ignore", "pipe", "ignore"] },
      );
      descendant.on("error", () => {
        process.exitCode = 1;
      });
      descendant.stdout.once("data", (data) => {
        if (data.length === 1 && data[0] === 1) {
          writeSync(3, Buffer.of(1));
          process.stdout.write(response);
        }
      });
    } else {
      process.stdout.write(response);
      if (mode === "abnormal") process.exitCode = 7;
    }
  }
} catch {
  process.exitCode = 1;
}

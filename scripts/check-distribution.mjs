import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseReady,
  verifyEvidenceFiles,
} from "./distribution/evidence.mjs";
const report = JSON.parse(
  readFileSync("artifacts/distribution-evidence.json", "utf8"),
);
try {
  if (!/^pdaa-distribution-\d+-[a-f0-9]{8}$/.test(report.runId))
    throw new Error("Invalid distribution evidence run ID");
  verifyEvidenceFiles(join("artifacts", report.runId), report);
  if (
    process.argv.slice(2).length === 1 &&
    process.argv[2] === "--evidence-only"
  ) {
    console.log(
      "Evidence files verified; distribution remains blocked pending review and trusted signing.",
    );
  } else {
    if (process.argv.length > 2)
      throw new Error("Unknown distribution check option");
    assertReleaseReady(report);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

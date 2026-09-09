import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseReady,
  verifyEvidenceFiles,
} from "./distribution/evidence.mjs";
import { verifyGoNoticeReports } from "./distribution/go-notices.mjs";
import { verifyNpmNoticeReports } from "./distribution/npm-notices.mjs";
import { verifyNodeComponentReports } from "./distribution/node-components.mjs";
import { verifyNodeSupplementReports } from "./distribution/node-supplemental.mjs";
import { verifyNodeResourceReports } from "./distribution/node-resources.mjs";
import { verifyNodeSourceReports } from "./distribution/node-resource-sources.mjs";
import { verifyGosuDispositionReport } from "./distribution/gosu-dispositions.mjs";
const report = JSON.parse(
  readFileSync("artifacts/distribution-evidence.json", "utf8"),
);
try {
  if (!/^pdaa-distribution-\d+-[a-f0-9]{8}$/.test(report.runId))
    throw new Error("Invalid distribution evidence run ID");
  verifyEvidenceFiles(join("artifacts", report.runId), report);
  verifyGoNoticeReports(join("artifacts", report.runId), report);
  verifyNpmNoticeReports(join("artifacts", report.runId), report);
  verifyNodeComponentReports(join("artifacts", report.runId), report);
  verifyNodeSupplementReports(join("artifacts", report.runId), report);
  verifyNodeResourceReports(join("artifacts", report.runId), report);
  verifyNodeSourceReports(join("artifacts", report.runId), report);
  verifyGosuDispositionReport(join("artifacts", report.runId), report);
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

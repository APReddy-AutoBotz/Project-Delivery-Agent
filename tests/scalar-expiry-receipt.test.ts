// FR-EVD-009 / SEC-AUTH-001: fail-closed independent expiry evidence controls.
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, copyFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { scalarExpiryFixture, expiryRunId } from "./fixtures/scalar-expiry.js";
import { assertScalarExpiryReceipt } from "../scripts/acceptance/scalar-expiry-receipt.mjs";
it("loads the production host readers before installing dependencies or building runtime packages", () => {
  const folder = mkdtempSync(join(tmpdir(), "pdaa-host-readers-"));
  const files = [
    "expiry-evidence.mjs",
    "scalar-expiry-receipt.mjs",
    "milestone-reconciliation-workflow-receipt.mjs",
    "scalar-reconciliation-recovery-receipt.mjs",
    "scalar-temporal-vectors-receipt.mjs",
    "scalar-identity-vectors-receipt.mjs",
  ];
  const copied: string[] = [];
  try {
    for (const file of files) {
      const target = join(folder, file);
      copyFileSync(join("scripts/acceptance", file), target);
      copied.push(target);
    }
    const imports = [
      "expiry-evidence.mjs",
      "scalar-temporal-vectors-receipt.mjs",
    ]
      .map(
        (file) =>
          `await import(${JSON.stringify(pathToFileURL(join(folder, file)).href)});`,
      )
      .join("\n");
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", imports],
      { cwd: folder, encoding: "utf8", timeout: 5000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
  } finally {
    for (const file of copied) unlinkSync(file);
    rmdirSync(folder);
  }
});
it("accepts original scalar proof and fixed denials after natural expiry", () => {
  expect(assertScalarExpiryReceipt(scalarExpiryFixture(), expiryRunId)).toBe(
    true,
  );
});
it.each([
  "run",
  "customer",
  "project",
  "request",
  "assessment",
  "owner",
  "login",
  "lifetime",
  "late-load",
  "early-clear",
  "deadline",
  "missing-denial",
  "early-denial",
  "wrong-path",
  "wrong-status",
  "browser-path",
  "browser-early",
  "bytes",
  "hash",
  "base64",
  "parsed-body",
  "changed-db",
  "missing-table",
  "extra-write",
  "credential",
  "recipient",
  "restricted",
  "resolved",
  "proof-customer",
])("rejects %s scalar expiry evidence", (kind) => {
  const r: any = scalarExpiryFixture();
  if (kind === "run") r.runId += "x";
  if (kind === "customer") r.customerId = r.projectId;
  if (kind === "project") r.projectId = r.factId;
  if (kind === "request") r.requestId = r.factId;
  if (kind === "assessment") r.assessmentId = r.factId;
  if (kind === "owner") r.principal.role = "fixture_admin";
  if (kind === "login") r.principal.login = "fixture_admin";
  if (kind === "lifetime") r.expiresAt++;
  if (kind === "late-load") r.loadedAt = r.expiresAt;
  if (kind === "early-clear") r.clearedAt = r.expiresAt - 1;
  if (kind === "deadline") r.clearedAt = r.issuedAt + 240000;
  if (kind === "missing-denial") r.denials.pop();
  if (kind === "early-denial") r.denials[0].at = r.expiresAt - 1;
  if (kind === "wrong-path") r.denials[0].path = "/api/me";
  if (kind === "wrong-status") r.denials[0].status = 404;
  if (kind === "browser-path") r.browserDenial.path = "/api/other";
  if (kind === "browser-early") r.browserDenial.at = r.expiresAt - 1;
  if (kind === "bytes") r.original.bytes++;
  if (kind === "hash") r.original.sha256 = "b".repeat(64);
  if (kind === "base64") r.original.bodyBase64 += " ";
  if (kind === "parsed-body") r.original.body.request.state = "CLOSED";
  if (kind === "changed-db") r.projection.after = "b".repeat(64);
  if (kind === "missing-table") delete r.projection.counts.FactSourceAccess;
  if (kind === "extra-write") r.projection.counts.ScalarReconciliationCheck++;
  if (kind === "credential") r.original.authorization = "private";
  if (
    ["recipient", "restricted", "resolved", "proof-customer"].includes(kind)
  ) {
    if (kind === "recipient")
      r.original.body.request.assignment.recipientSubject = "other";
    if (kind === "restricted")
      r.original.body.assessment.visibility = "restricted";
    if (kind === "resolved")
      r.original.body.assessment.result.status = "RESOLVED";
    if (kind === "proof-customer")
      r.original.body.assessment.result.scope.customerId = r.projectId;
    const bytes = Buffer.from(JSON.stringify(r.original.body));
    Object.assign(r.original, {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bodyBase64: bytes.toString("base64"),
    });
  }
  expect(() => assertScalarExpiryReceipt(r, expiryRunId)).toThrow();
});

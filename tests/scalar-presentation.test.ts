// FR-EVD-003/007/009/010/012: preserve every evidence state in the approved design.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AssessmentView } from "../apps/web/src/evidence-display.js";
import { ScalarAssignment } from "../apps/web/src/scalar-reconciliation.js";
import {
  scalarContractFixture,
  scalarId,
} from "./fixtures/scalar-reconciliation.js";

// Use the web workspace's already-pinned renderer; no new runtime dependency.
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { createElement } = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const render = (component: unknown, props: unknown): string =>
  renderToStaticMarkup(createElement(component, props));

describe("Antigravity presentation on the validated scalar workflow", () => {
  it("preserves the exact approved global stylesheet", () => {
    const css = readFileSync("apps/web/src/style.css", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    // Immutable PR #53 candidate 72f822e; not derived from the current file at runtime.
    expect(createHash("sha256").update(css).digest("hex")).toBe(
      "f76435486372ae6591279eafdf10d3cbb96ccffa6048b0306771f86b0723a3e0",
    );
  });

  it("keeps assigned and unassigned reasons explicit without implying resolution", () => {
    const { request } = scalarContractFixture();
    const assigned = render(ScalarAssignment, { item: request });
    expect(assigned).toContain("Assigned to pm-atlas");
    expect(assigned).toContain("OPEN");
    expect(assigned).toContain("No source value has been changed");
    for (const [reason, explanation] of [
      ["NO_CONFIGURED_PM", "No configured Project Manager responsibility"],
      ["AMBIGUOUS_CONFIGURED_PM", "Multiple Project Manager responsibilities"],
      ["PM_SCOPE_UNAVAILABLE", "lacks an active project_manager grant"],
    ]) {
      const html = render(ScalarAssignment, {
        item: {
          ...request,
          assignment: { ...request.assignment, reason, recipientSubject: null },
        },
      });
      expect(html).toContain(explanation);
      expect(html).toContain("scalar-unassigned");
      expect(html).not.toContain("pm-atlas");
    }
  });

  it("does not filter stale or superseded positions out of the comparison grid", () => {
    const { assessment, request } = scalarContractFixture();
    const old = structuredClone(assessment.result.versions[0]!);
    if (old.visibility !== "available")
      throw new Error("Available fixture required");
    old.id = scalarId(999);
    old.temporalApplicability = "SUPERSEDED";
    old.eligibilityReasons = ["NOT_APPLICABLE", "STALE"];
    old.assessment.freshness = "STALE";
    old.assessment.classification = "CONFLICTING";
    old.value = { type: "text", value: "Retained earlier position" };
    const compared = {
      ...assessment,
      result: {
        ...assessment.result,
        versions: [...assessment.result.versions, old],
      },
    };
    const html = render(AssessmentView, {
      delivery: compared,
      projectId: request.projectId,
      comparison: true,
    });
    expect(html).toContain("conflict-comparison");
    expect(html).toContain("Retained earlier position");
    expect(html).toContain("SUPERSEDED");
    expect(html).toContain("Expired at capture");
    expect(html).toContain("Provenance:");
    expect(html).toContain("Freshness:");
    expect(html).toContain("Conflict:");
    expect(html).toContain(old.id);
    expect(html).toContain(old.evidenceIds[0]);
    expect(html).toContain("This assessment flag alone is not a durable");
    expect(html).toContain("describes its capture time");
  });

  it("withholds the entire comparison when current source access is restricted", () => {
    const { restricted, request } = scalarContractFixture();
    const html = render(AssessmentView, {
      delivery: restricted,
      projectId: request.projectId,
      comparison: true,
    });
    expect(html).toContain("Saved result withheld");
    expect(html).not.toContain("conflict-comparison");
    expect(html).not.toContain("2026-10-01");
    expect(html).not.toContain("2026-10-02");
  });
});

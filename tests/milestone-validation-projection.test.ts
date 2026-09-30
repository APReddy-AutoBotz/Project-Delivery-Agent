// FR-EVD-004/009, NFR-REL-001/002: the additive validator changes only its
// measured query projection. All old validation/seal/COMMIT semantics remain.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = "packages/data/prisma/migrations/";
const read = (name: string) =>
  readFileSync(root + name + "/migration.sql", "utf8").replaceAll("\r\n", "\n");
it("pins the original validator and permits only the materialized identity projection", () => {
  const original = read("202609120001_milestone_consistency_persistence");
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "4228440e0a7142b493f05dbcad76536e10d4b4b7da2f407fc393b8d6485a28c1",
  );
  const sql = read("202609220001_milestone_validation_projection");
  const functionPattern =
    /CREATE(?: OR REPLACE)? FUNCTION public\.valid_milestone_consistency_assessment\(target uuid\)[\s\S]*?END \$\$;/;
  const oldFunction = original.match(functionPattern)![0];
  const newFunction = sql.match(functionPattern)![0];
  expect(sql.replace(/^--[^\n]*\n/gm, "").trim()).toBe(newFunction);
  const cte = `    WITH child_inputs AS MATERIALIZED (
      SELECT t."targetKind",t."milestoneId",t."workItemId",t."bindingId",t."factId",t."factType",
        f.result->'versions' AS versions,f.result->'supportingVersionIds' AS supporting_ids,
        f.result->'resolvedValue'->>'value' AS resolved_state
      FROM public."MilestoneConsistencyTarget" t JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId"
      WHERE t."assessmentId"=a.id
    )
`;
  expect(newFunction.split(cte)).toHaveLength(2);
  const reverted = newFunction
    .replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION")
    .replace(cte, "")
    .replace(
      "FROM child_inputs t CROSS JOIN LATERAL jsonb_array_elements(t.versions) version\n      WHERE t.supporting_ids",
      `FROM public."MilestoneConsistencyTarget" t JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId"
      CROSS JOIN LATERAL jsonb_array_elements(f.result->'versions') version
      WHERE t."assessmentId"=a.id AND f.result->'supportingVersionIds'`,
    )
    .replaceAll("t.resolved_state", "f.result->'resolvedValue'->>'value'");
  expect(reverted).toBe(oldFunction);
});

it("requires the complete pinned release ledger after a prior-prefix upgrade", () => {
  const helper = readFileSync(
    "scripts/acceptance/project-fact-upgrade.mjs",
    "utf8",
  );
  expect(helper).toContain("assert.equal(migrations.length, 22)");
  expect(helper).toContain('"202609300001_update_engagement_storage"');
  expect(helper).toContain('"202609280004_project_update_workflow"');
  expect(helper).toContain('"202609290001_schedule_health_policy"');
  expect(helper).toContain('"202609290002_project_update_cadence"');
  expect(helper).toContain('"202609270001_health_assessment"');
  expect(helper).toContain('"202609220001_milestone_validation_projection"');
  expect(helper).toContain('"202609260001_connector_outcome_sync_scope"');
  expect(helper).toContain("assert.equal(applied.length, migrations.length)");
  expect(helper).not.toMatch(/assert\.equal\(applied\.length,\s*8\)/);
});

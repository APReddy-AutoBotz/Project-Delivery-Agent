import { describe, expect, it } from "vitest";
import { buildSourceAuthoritySnapshot } from "../packages/data/dist/authority-persistence.js";
import { selectCanonicalProjectUpdateTimestamp } from "../packages/data/dist/project-updates.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const factId = "40000000-0000-4000-8000-000000000001";
const sourceId = "50000000-0000-4000-8000-000000000001";
const versionId = "60000000-0000-4000-8000-000000000001";
const evidenceId = "70000000-0000-4000-8000-000000000001";
const observedAt = new Date("2026-06-09T00:00:00.000Z");
const effectiveAt = new Date("2026-05-01T00:00:00.000Z");
const asOf = new Date("2026-06-10T00:00:00.000Z");

describe("Project update timestamp authority boundary", () => {
  it("uses the persisted canonical source identity and never treats visibility as adapter validation", () => {
    const authority = buildSourceAuthoritySnapshot(
      { customerId, projectId, factId, factType: "project.status" } as never,
      asOf.toISOString(),
      null,
      [{
        id: versionId,
        sourceId,
        evidenceId,
        value: { type: "text", value: "In progress" },
        provenance: "HUMAN_CONFIRMED",
        effectiveAt,
        validUntil: null,
        evidence: { observedAt },
      }] as never,
      [],
      [],
      true,
    );

    expect(authority.sources).toEqual([{
      instanceId: sourceId,
      sourceType: "human_statement",
    }]);
    const human = selectCanonicalProjectUpdateTimestamp({
      sourceType: authority.sources[0]!.sourceType,
      selectedBasis: "effectiveAt",
      observedAt,
      effectiveAt,
      asOf,
    });
    expect(human).toEqual({
      timestampBasis: "HUMAN_OBSERVED_AT",
      timestamp: observedAt,
    });

    const connectorWithoutValidation = selectCanonicalProjectUpdateTimestamp({
      sourceType: "jira_connector",
      selectedBasis: "effectiveAt",
      observedAt,
      effectiveAt,
      asOf,
    });
    expect(connectorWithoutValidation).toEqual({
      timestampBasis: "UNCONFIRMED",
      timestamp: null,
    });
  });
});

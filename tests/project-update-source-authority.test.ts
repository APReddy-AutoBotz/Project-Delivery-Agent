import { describe, expect, it } from "vitest";
import {
  resolveSourceAuthority,
  type SourceAuthoritySnapshot,
} from "../packages/domain/dist/index.js";
import { buildSourceAuthoritySnapshot } from "../packages/data/dist/authority-persistence.js";
import { selectCanonicalProjectUpdateTimestamp } from "../packages/data/dist/project-updates.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const factId = "40000000-0000-4000-8000-000000000001";
const observedAt = new Date("2026-06-09T00:00:00.000Z");
const effectiveAt = new Date("2026-05-01T00:00:00.000Z");
const asOf = new Date("2026-06-10T00:00:00.000Z");

function snapshot(input: {
  sourceType: string;
  effectiveAtValidated: boolean;
  provenance: string;
  sourceId: string;
  versionId: string;
  evidenceId: string;
}): SourceAuthoritySnapshot {
  return buildSourceAuthoritySnapshot(
    { customerId, projectId, factId, factType: "project.status" } as never,
    asOf.toISOString(),
    null,
    [{
      id: input.versionId,
      sourceId: input.sourceId,
      evidenceId: input.evidenceId,
      value: { type: "text", value: "In progress" },
      provenance: input.provenance,
      effectiveAtValidated: input.effectiveAtValidated,
      effectiveAt,
      validUntil: null,
      evidence: {
        observedAt,
        source: { sourceType: input.sourceType },
      },
    }] as never,
    [],
    [{
      sourceId: input.sourceId,
      state: "AVAILABLE",
      readers: [{ subject: "reviewer@example.invalid" }],
    }] as never,
    true,
  );
}

describe("Project update timestamp authority boundary", () => {
  it("keeps adapter validation in the trusted input snapshot, outside persisted assessment output", () => {
    const humanSnapshot = snapshot({
      sourceType: "human_statement",
      effectiveAtValidated: false,
      provenance: "HUMAN_CONFIRMED",
      sourceId: "50000000-0000-4000-8000-000000000001",
      versionId: "60000000-0000-4000-8000-000000000001",
      evidenceId: "70000000-0000-4000-8000-000000000001",
    });
    const human = resolveSourceAuthority(humanSnapshot).versions[0]!;
    const humanVersion = humanSnapshot.versions[0]!;
    expect(human).toMatchObject({
      sourceType: "human_statement",
      visibility: "available",
    });
    expect(human).not.toHaveProperty("effectiveAtValidated");
    expect(humanVersion).toMatchObject({ effectiveAtValidated: false });
    expect(selectCanonicalProjectUpdateTimestamp({
      sourceType: human.sourceType!,
      selectedBasis: "effectiveAt",
      observedAt,
      effectiveAt,
      effectiveAtValidated: humanVersion.effectiveAtValidated === true,
      asOf,
    })).toEqual({
      timestampBasis: "HUMAN_OBSERVED_AT",
      timestamp: observedAt,
    });

    const validatedConnectorSnapshot = snapshot({
      sourceType: "jira_connector",
      effectiveAtValidated: true,
      provenance: "SYSTEM_VERIFIED",
      sourceId: "50000000-0000-4000-8000-000000000002",
      versionId: "60000000-0000-4000-8000-000000000002",
      evidenceId: "70000000-0000-4000-8000-000000000002",
    });
    const connector = resolveSourceAuthority(validatedConnectorSnapshot).versions[0]!;
    const connectorVersion = validatedConnectorSnapshot.versions[0]!;
    expect(connector).toMatchObject({
      sourceType: "jira_connector",
      visibility: "available",
    });
    expect(connector).not.toHaveProperty("effectiveAtValidated");
    expect(connectorVersion).toMatchObject({ effectiveAtValidated: true });
    expect(selectCanonicalProjectUpdateTimestamp({
      sourceType: connector.sourceType!,
      selectedBasis: "effectiveAt",
      observedAt,
      effectiveAt,
      effectiveAtValidated: connectorVersion.effectiveAtValidated === true,
      asOf,
    })).toEqual({
      timestampBasis: "CONNECTOR_EFFECTIVE_AT",
      timestamp: effectiveAt,
    });

    const unvalidated = selectCanonicalProjectUpdateTimestamp({
      sourceType: "jira_connector",
      selectedBasis: "effectiveAt",
      observedAt,
      effectiveAt,
      effectiveAtValidated: false,
      asOf,
    });
    expect(unvalidated).toEqual({
      timestampBasis: "UNCONFIRMED",
      timestamp: null,
    });
  });
});

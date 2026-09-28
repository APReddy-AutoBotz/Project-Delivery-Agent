import { expect, it } from "vitest";
import { hasTrustedBlockerAgeEvidence } from "../packages/data/src/blocker-age-proof.js";

type Evidence = Parameters<typeof hasTrustedBlockerAgeEvidence>[0];

function resolution(
  sourceType: string,
  provenance: string,
  validity:
    | { mode: "UNTIL_SUPERSEDED" }
    | { basis: "observedAt"; durationMs: number }
    | null,
  freshness = "CURRENT",
  visibility = "available",
): Evidence {
  return {
    status: "RESOLVED",
    policy: { tiers: [{ selectors: [{ validity }] }] },
    resolvedValue: { type: "boolean", value: true },
    supportingVersionIds: ["version-1"],
    supportingEvidenceIds: ["evidence-1"],
    versions: [
      {
        id: "version-1",
        sourceType,
        provenance,
        visibility,
        assessment: { freshness },
      },
    ],
  };
}

it("requires current human-confirmed facts for blocker classification and inventory completeness", () => {
  const factType = "project.open_blocker_inventory_complete";
  const finiteRule = { basis: "observedAt" as const, durationMs: 86_400_000 };
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", finiteRule),
      factType,
      false,
    ),
  ).toBe(true);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("system_verified", "SYSTEM_VERIFIED", finiteRule),
      factType,
      false,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "SYSTEM_VERIFIED", finiteRule),
      factType,
      false,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", {
        mode: "UNTIL_SUPERSEDED",
      }),
      factType,
      false,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", null),
      factType,
      false,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", {
        basis: "observedAt",
        durationMs: 0,
      }),
      factType,
      false,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", {
        basis: "observedAt",
        durationMs: Number.POSITIVE_INFINITY,
      }),
      factType,
      false,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", finiteRule, "STALE"),
      factType,
      false,
    ),
  ).toBe(false);
});

it("allows UNTIL_SUPERSEDED only for a current human RAID opened-date proof", () => {
  const factType =
    "raid_item.11111111-2222-4333-8444-555555555555.opened_at";
  const openedRule = { mode: "UNTIL_SUPERSEDED" as const };
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", openedRule),
      factType,
      true,
    ),
  ).toBe(true);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("system_verified", "SYSTEM_VERIFIED", openedRule),
      factType,
      true,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution("human_statement", "HUMAN_CONFIRMED", openedRule),
      "project.open_blocker_inventory_complete",
      true,
    ),
  ).toBe(false);
  expect(
    hasTrustedBlockerAgeEvidence(
      resolution(
        "human_statement",
        "HUMAN_CONFIRMED",
        { basis: "observedAt", durationMs: 86_400_000 },
      ),
      factType,
      true,
    ),
  ).toBe(false);
});

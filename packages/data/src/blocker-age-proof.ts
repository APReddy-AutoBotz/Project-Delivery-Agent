import { isBlockerOpenedAtFactType } from "@pdaa/domain";

type Resolution = {
  policy?: {
    tiers: {
      selectors: {
        validity:
          | { mode?: string }
          | { basis: string; durationMs: number }
          | null;
      }[];
    }[];
  } | null;
  supportingVersionIds: string[];
  versions: {
    id: string;
    visibility?: string;
    provenance?: string;
    sourceType?: string;
    assessment?: { freshness?: string };
  }[];
};

export function hasTrustedBlockerAgeEvidence(
  result: Resolution,
  factType: string,
  requireOpenedPeriod: boolean,
) {
  const selectors = result.policy?.tiers.flatMap((tier) => tier.selectors) ?? [];
  const usesUntilSuperseded = selectors.some(
    (selector) =>
      selector.validity !== null &&
      typeof selector.validity === "object" &&
      "mode" in selector.validity,
  );
  const allUntilSuperseded =
    selectors.length > 0 &&
    selectors.every(
      (selector) =>
        selector.validity !== null &&
        typeof selector.validity === "object" &&
        "mode" in selector.validity &&
        selector.validity.mode === "UNTIL_SUPERSEDED",
    );
  const validityAllowed = requireOpenedPeriod
    ? isBlockerOpenedAtFactType(factType) && allUntilSuperseded
    : !usesUntilSuperseded;
  if (!validityAllowed) return false;

  const supporting = result.supportingVersionIds;
  const selectedRows = result.versions.filter((version) =>
    supporting.includes(version.id),
  );
  return (
    supporting.length > 0 &&
    selectedRows.length === supporting.length &&
    selectedRows.every(
      (version) =>
        version.visibility === "available" &&
        version.assessment?.freshness === "CURRENT" &&
        version.sourceType === "human_statement" &&
        version.provenance === "HUMAN_CONFIRMED",
    )
  );
}

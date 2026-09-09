import { z } from "zod";

export const provenanceSchema = z.enum([
  "SYSTEM_VERIFIED",
  "HUMAN_CONFIRMED",
  "AGENT_INFERENCE",
  "UNKNOWN",
]);
export type Provenance = z.infer<typeof provenanceSchema>;

// FR-EVD-003: assessed validity must never overwrite the version's origin.
export function assessFact(
  input: {
    provenance: Provenance;
    validUntil: string | null;
    conflicting: boolean;
  },
  asOf: Date,
) {
  const expiry = input.validUntil === null ? NaN : Date.parse(input.validUntil);
  if (!Number.isFinite(asOf.getTime()))
    throw new Error("Invalid assessment time");
  const freshness = !Number.isFinite(expiry)
    ? "UNKNOWN"
    : asOf.getTime() >= expiry
      ? "STALE"
      : "CURRENT";
  const conflict = input.conflicting ? "CONFLICTING" : "NONE";
  const classification =
    conflict === "CONFLICTING"
      ? conflict
      : freshness !== "CURRENT"
        ? freshness
        : input.provenance;
  return Object.freeze({
    provenance: input.provenance,
    freshness,
    conflict,
    classification,
    assessedAt: asOf.toISOString(),
  });
}

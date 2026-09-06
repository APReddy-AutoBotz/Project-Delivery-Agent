import { z } from "zod";

export const roles = [
  "leadership",
  "project_manager",
  "contributor",
  "pmo_admin",
  "system_admin",
] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;
export interface Actor {
  subject: string;
  roles: Role[];
  customerId: string;
}
export interface Project {
  id: string;
  portfolioId: string;
  code: string;
  name: string;
  description: string;
  reportedStatus: string;
}
export interface Grant {
  subject: string;
  scopeType: "project" | "portfolio";
  scopeId: string;
  role: Role;
}
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

export function canReadProject(
  actor: Actor,
  project: Project,
  grants: Grant[],
): boolean {
  return grants.some(
    (g) =>
      g.subject === actor.subject &&
      (g.scopeType === "project"
        ? g.scopeId === project.id
        : g.scopeId === project.portfolioId),
  );
}

export interface ProjectRepository {
  listProjects(actor: Actor): Promise<Project[]>;
  getProject(actor: Actor, id: string): Promise<Project | null>;
  setGrant(actor: Actor, grant: Grant, correlationId: string): Promise<void>;
  revokeGrant(
    actor: Actor,
    grant: Omit<Grant, "role">,
    correlationId: string,
  ): Promise<void>;
  listAudit(
    actor: Actor,
  ): Promise<{ id: string; event: string; actor: string; occurredAt: Date }[]>;
  ready(): Promise<boolean>;
  heartbeat(): Promise<Date | null>;
}

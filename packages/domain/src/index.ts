import type { Actor, Role } from "./actor.js";
export { roles, roleSchema, type Role, type Actor } from "./actor.js";
export * from "./project-facts.js";
export * from "./canonical-project.js";
export {
  resolveSourceAuthority,
  sourceAuthorityPolicySchema,
  sourceAuthoritySnapshotSchema,
  type SourceAuthorityPolicy,
  type SourceAuthoritySnapshot,
} from "./source-authority.js";

export { assessFact, provenanceSchema, type Provenance } from "./fact-state.js";
export {
  authorityDefinitionSchema,
  authorityTargetSchema,
  authorityPolicyChangeSchema,
  assessmentCaptureSchema,
  assessmentReadSchema,
  type AuthorityDefinition,
  type AuthorityPolicyChange,
  type AuthorityTarget,
  type AssessmentCapture,
  type AssessmentRead,
  type AuthorityAssessment,
  type AuthorityPolicyEvent,
  type ActiveAuthorityPolicy,
  type AssessmentDelivery,
  type AuthorityRepository,
} from "./authority-persistence.js";
export {
  assessTemporalFactHistory,
  temporalFactSnapshotSchema,
  type TemporalFactSnapshot,
} from "./temporal-facts.js";

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

// TR-STACK-005: tasks receive a narrow persistence port, never an ORM client.
export interface WorkerHeartbeatRepository {
  recordHeartbeat(occurredAt: Date): Promise<void>;
}

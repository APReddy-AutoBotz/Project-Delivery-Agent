import { z } from "zod";
import type { Actor } from "./actor.js";
import { temporalFactSnapshotSchema } from "./temporal-facts.js";

// FR-EVD-001/002/003/004/005/009: historical storage contracts, not resolution.
const version = temporalFactSnapshotSchema.shape.versions.element.shape;
const scope = temporalFactSnapshotSchema.shape.scope.shape;
export const projectFactIdSchema = scope.projectId;
export const projectFactSubjectSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((text) => text.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(text));
export const projectFactInstantSchema = version.effectiveAt.refine(
  (text) => !text.startsWith("0000-"),
);
export const projectFactValueSchema = version.value.refine(
  (value) =>
    (value.type !== "text" || !/[\0\p{Surrogate}]/u.test(value.value)) &&
    (value.type !== "date" || !value.value.startsWith("0000-")),
);
const counter = z.number().int().min(0).max(2147483646);
const target = { projectId: scope.projectId, factType: scope.factType };
export const humanStatementSchema = z
  .object({
    ...target,
    expectedRevision: counter,
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    value: projectFactValueSchema,
    effectiveAt: projectFactInstantSchema,
    validUntil: projectFactInstantSchema.nullable().default(null),
    originalStatement: z
      .string()
      .min(1)
      .max(8192)
      .refine(
        (text) => text.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(text),
      ),
  })
  .strict()
  .refine(
    (request) =>
      request.validUntil === null || request.validUntil >= request.effectiveAt,
  );
export const factHistoryRequestSchema = z
  .object({
    ...target,
    afterRevision: counter.default(0),
    throughRevision: z
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .nullable()
      .default(null),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((request) =>
    request.throughRevision === null
      ? request.afterRevision === 0
      : request.throughRevision >= request.afterRevision,
  );
export const sourceAccessChangeSchema = z
  .object({
    projectId: scope.projectId,
    sourceId: scope.projectId,
    expectedRevision: counter.min(1),
    state: z.enum(["AVAILABLE", "REVOKED", "DELETED", "UNVERIFIABLE"]),
    readers: z
      .array(projectFactSubjectSchema)
      .max(100)
      .refine((readers) => new Set(readers).size === readers.length),
  })
  .strict();
export const factMutationContextSchema = z
  .object({
    correlationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();
export type HumanStatement = z.input<typeof humanStatementSchema>;
export type FactHistoryRequest = z.input<typeof factHistoryRequestSchema>;
export type SourceAccessChange = z.input<typeof sourceAccessChangeSchema>;
export type FactMutationContext = z.infer<typeof factMutationContextSchema>;
export type ProjectFactValue = z.infer<typeof projectFactValueSchema>;
export type FactHistoryEntry = {
  id: string;
  revision: number;
  sourceId: string;
  evidenceId: string;
  sourceAccessRevision: number;
} & (
  | {
      visibility: "restricted";
      revalidationRequired: true;
    }
  | {
      visibility: "available";
      revalidationRequired: false;
      content: {
        value: ProjectFactValue;
        originalStatement: string;
        providedBy: string;
        provenance: "HUMAN_CONFIRMED";
        effectiveAt: string;
        observedAt: string;
        confirmedAt: string;
        validUntil: string | null;
        source: {
          instanceId: string;
          recordType: "human_statement";
          recordId: string;
          revision: string;
        };
        evidenceIds: [string];
      };
    }
);
export interface FactHistoryPage {
  factId: string;
  factType: string;
  throughRevision: number;
  entries: FactHistoryEntry[];
  next: { afterRevision: number; throughRevision: number } | null;
  historical: true;
}
export interface HumanStatementResult {
  factId: string;
  replayed: boolean;
  entry: FactHistoryEntry;
}
export class ProjectFactError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "DENIED"
      | "REVISION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "SOURCE_RESTRICTED",
  ) {
    super("Project fact operation rejected");
    this.name = "ProjectFactError";
  }
}
export interface ProjectFactRepository {
  appendHumanStatement(
    actor: Actor,
    request: HumanStatement,
    context: FactMutationContext,
  ): Promise<HumanStatementResult>;
  getHistory(
    actor: Actor,
    request: FactHistoryRequest,
  ): Promise<FactHistoryPage | null>;
  setSourceAccess(
    actor: Actor,
    request: SourceAccessChange,
    context: FactMutationContext,
  ): Promise<{ sourceId: string; revision: number }>;
}

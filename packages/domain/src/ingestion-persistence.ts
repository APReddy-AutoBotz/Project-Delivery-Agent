import { z } from "zod";
import {
  connectorBindingSchema,
  ingestionArray,
  ingestionFactType,
  ingestionText,
} from "./connector.js";
import { projectFactIdSchema } from "./project-facts.js";
import { spreadsheetPreviewConfigSchema } from "./spreadsheet-preview.js";

const unique = (items: readonly string[]) => new Set(items).size === items.length;
const field = z
  .object({
    column: ingestionText(256),
    factType: ingestionFactType,
    type: z.enum(["text", "date", "number", "boolean"]),
    required: z.boolean(),
  })
  .strict();
const csvMapping = z
  .object({
    kind: z.literal("CSV"),
    sheet: ingestionText(256),
    identityColumn: ingestionText(256),
    projectColumn: ingestionText(256),
    fields: ingestionArray(field, 32).refine(
      (fields) =>
        fields.length > 0 &&
        unique(fields.map((item) => item.column)) &&
        unique(fields.map((item) => item.factType)),
    ),
  })
  .strict()
  .refine((value) => value.identityColumn !== value.projectColumn);
const connectorMapping = z
  .object({
    kind: z.literal("CONNECTOR"),
    factTypes: ingestionArray(ingestionFactType, 32).refine(unique),
    // Opaque, bounded adapter-owned JSON keeps vendor types out of the domain
    // package while the sealed configuration revision preserves its exact map.
    adapterConfiguration: ingestionText(30_000).optional(),
  })
  .strict();
export const ingestionConfigurationSchema = z
  .object({
    binding: connectorBindingSchema,
    projects: ingestionArray(
      z
        .object({
          projectId: projectFactIdSchema,
          readers: ingestionArray(ingestionText(256), 100).refine(unique),
        })
        .strict(),
      100,
    ).refine(
      (projects) =>
        projects.length > 0 && unique(projects.map((project) => project.projectId)),
    ),
    mapping: z.discriminatedUnion("kind", [csvMapping, connectorMapping]),
  })
  .strict();
export type IngestionConfiguration = z.infer<
  typeof ingestionConfigurationSchema
>;
export const ingestionCommandKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const ingestionCursorStateSchema = z.enum([
  "READY",
  "TERMINAL",
  "RESET_REQUIRED",
]);
export const ingestionRowStateSchema = z.enum([
  "ACCEPTED",
  "INVALID",
  "REVIEW_REQUIRED",
]);
export const ingestionRowOperationSchema = z.enum([
  "CREATE",
  "UPDATE",
  "UNCHANGED",
  "NONE",
]);
export const ingestionSafeErrorSchema = z.enum([
  "INVALID_INPUT",
  "INVALID_KEY",
  "DUPLICATE_KEY",
  "INVALID_PROJECT",
  "PROJECT_CHANGED",
  "INVALID_FIELDS",
  "ROW_IDENTITY_REVIEW",
  "REQUIRED_VALUE",
  "INVALID_FORMULA",
  "INVALID_NUMBER",
  "INVALID_VALUE",
]);
export const ingestionHealthCodeSchema = z.enum([
  "NONE",
  "INVALID_CREDENTIALS",
  "EXPIRED_CREDENTIALS",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "TEMPORARILY_UNAVAILABLE",
  "INVALID_RESPONSE",
  "NOT_FOUND",
  "UNKNOWN_OUTCOME",
  "INTEGRITY_CONFLICT",
  "CURSOR_CONFLICT",
]);
export const ingestionReceiptKindSchema = z.enum([
  "CONNECTOR_PAGE",
  "CONNECTOR_EVENT",
  "CSV_PREVIEW",
  "SYNC_RESET",
]);
export type IngestionSyncSnapshot = {
  sourceId: string;
  configuration: IngestionConfiguration;
  configRevision: number;
  mappingRevision: number;
  cursor: string | null;
  cursorRevision: number;
  generation: number;
  cursorState: z.infer<typeof ingestionCursorStateSchema>;
};
export const ingestionReceiptReadSchema = z
  .object({
    sourceId: projectFactIdSchema,
    receiptId: projectFactIdSchema,
  })
  .strict();
export const ingestionRetentionSchema = z
  .object({ retentionHours: z.number().int().min(1).max(2_147_483_647) })
  .strict();

// Persistence is a narrow service port. Callers supply user intent and validated
// actor identity; database implementations recheck current grants and source ACL.
export interface IngestionRepository {
  readSyncSnapshot(
    actor: import("./actor.js").Actor,
    sourceId: string,
  ): Promise<IngestionSyncSnapshot>;
  configure(
    actor: import("./actor.js").Actor,
    input: IngestionConfiguration,
    correlationId: string,
  ): Promise<{ sourceId: string; configRevision: number; mappingRevision: number }>;
  persistConnectorPage(
    actor: import("./actor.js").Actor,
    input: {
      sourceId: string;
      configRevision: number;
      mappingRevision: number;
      expectedCursorRevision: number;
      expectedGeneration: number;
      commandKey: string;
      page: unknown;
    },
    correlationId: string,
  ): Promise<{ receiptId: string; replayed: boolean; cursorRevision: number }>;
  persistConnectorEvent(
    actor: import("./actor.js").Actor,
    input: {
      sourceId: string;
      configRevision: number;
      mappingRevision: number;
      commandKey: string;
      eventId: string;
      record: unknown;
    },
    correlationId: string,
  ): Promise<{ receiptId: string; replayed: boolean }>;
  persistCsvPreview(
    actor: import("./actor.js").Actor,
    input: {
      sourceId: string;
      configRevision: number;
      mappingRevision: number;
      commandKey: string;
      fileName: string;
      csv: unknown;
      baseline?: unknown;
    },
    correlationId: string,
  ): Promise<{ receiptId: string; replayed: boolean; rowCount: number }>;
  resetSync(
    actor: import("./actor.js").Actor,
    input: {
      sourceId: string;
      configRevision: number;
      expectedCursorRevision: number;
      expectedGeneration: number;
      commandKey: string;
    },
    correlationId: string,
  ): Promise<{ receiptId: string; generation: number; cursorRevision: number }>;
  readReceipt(
    actor: import("./actor.js").Actor,
    input: z.infer<typeof ingestionReceiptReadSchema>,
  ): Promise<unknown>;
  recordHealth(
    actor: import("./actor.js").Actor,
    sourceId: string,
    state: "HEALTHY" | "DEGRADED" | "FAILED",
    code: z.infer<typeof ingestionHealthCodeSchema>,
    correlationId: string,
  ): Promise<void>;
  setRetention(
    actor: import("./actor.js").Actor,
    input: z.infer<typeof ingestionRetentionSchema>,
    correlationId: string,
  ): Promise<number>;
  purgeExpired(actor: import("./actor.js").Actor): Promise<number>;
}

export const ingestionPreviewRequestSchema = z
  .object({
    sourceId: projectFactIdSchema,
    fileName: ingestionText(256),
    csv: z.string().max(1_048_576),
    commandKey: ingestionCommandKeySchema,
  })
  .strict();
export const ingestionCursorSchema = z
  .object({
    cursor: ingestionText(2048).nullable(),
    revision: z.number().int().min(0),
    generation: z.number().int().min(1),
    state: ingestionCursorStateSchema,
  })
  .strict();

// Validate persisted CSV identity with the same exact sheet/key binding used by
// previewSpreadsheetCsv. This schema is exported for callers that expose previews.
export const persistedSpreadsheetConfigSchema = spreadsheetPreviewConfigSchema;

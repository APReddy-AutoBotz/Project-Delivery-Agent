// TR-API-001 / CI-FND-001: one runtime schema source for every controller operation.
import type {
  OpenAPIObject,
  SchemaObject,
  OperationObject,
} from "@nestjs/swagger";
import { z } from "zod";
import {
  roleSchema,
  canonicalSetupSchema,
  canonicalProgrammeSchema,
  canonicalProgrammeCreateSchema,
  canonicalProjectCreateSchema,
  canonicalProjectDetailSchema,
  factCatalogueSchema,
  humanStatementSchema,
  factHistoryPageSchema,
  humanStatementResultSchema,
  sourceAccessViewSchema,
  sourceAccessChangeSchema,
  activeAuthorityPolicySchema,
  authorityPolicyChangeSchema,
  policyChangeResultSchema,
  assessmentCaptureSchema,
  assessmentDeliverySchema,
} from "@pdaa/domain";
import {
  catalogueQuerySchema,
  historyQuerySchema,
} from "./evidence-controller.js";

// The wire pattern preserves the existing 1..200 limit after trimming. A raw
// maxLength would incorrectly reject a valid subject padded with whitespace.
const subjectSchema = z
  .string()
  .regex(/^\s*(?:\S|\S[\s\S]{0,198}\S)\s*$/)
  .describe(
    "Account subject, 1 to 200 characters after trimming surrounding whitespace",
  )
  .transform((value) => value.trim());
export const grantSchema = z.strictObject({
  subject: subjectSchema,
  scopeType: z.enum(["project", "portfolio"]),
  scopeId: z.uuid(),
  role: roleSchema,
});
export const revokeSchema = grantSchema.omit({ role: true });
export const developmentSchema = z.strictObject({
  persona: z.enum(["pm-atlas", "leader-atlas", "operator", "pmo-portfolio"]),
});
const project = z.strictObject({
  id: z.uuid(),
  portfolioId: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  reportedStatus: z.string(),
});
const modes = z.enum(["oidc", "development"]);
const dataModes = z.enum(["synthetic", "customer"]);
export type RouteContract = {
  status: number;
  response?: z.ZodType;
  request?: z.ZodType;
  public?: boolean;
  errors?: number[];
  parameters?: Record<string, z.ZodType>;
  query?: Record<string, z.ZodType>;
};
export const contracts: Record<string, RouteContract> = {
  "get /api/projects/{id}/facts": {
    status: 200,
    response: factCatalogueSchema,
    parameters: { id: z.uuid() },
    query: catalogueQuerySchema.shape,
    errors: [404, 503],
  },
  "get /api/projects/{id}/facts/{factType}/history": {
    status: 200,
    response: factHistoryPageSchema,
    parameters: { id: z.uuid(), factType: humanStatementSchema.shape.factType },
    query: historyQuerySchema.shape,
    errors: [404, 503],
  },
  "post /api/projects/{id}/fact-statements": {
    status: 201,
    request: humanStatementSchema,
    response: humanStatementResultSchema,
    parameters: { id: z.uuid() },
    errors: [404, 409, 503],
  },
  "get /api/projects/{id}/fact-sources/{sourceId}/access": {
    status: 200,
    response: sourceAccessViewSchema,
    parameters: { id: z.uuid(), sourceId: z.uuid() },
    errors: [404, 503],
  },
  "post /api/projects/{id}/fact-sources/{sourceId}/access": {
    status: 200,
    request: sourceAccessChangeSchema,
    response: z.strictObject({
      sourceId: z.uuid(),
      revision: z.number().int().min(1).max(2147483647),
    }),
    parameters: { id: z.uuid(), sourceId: z.uuid() },
    errors: [404, 409, 503],
  },
  "get /api/projects/{id}/facts/{factType}/authority": {
    status: 200,
    response: activeAuthorityPolicySchema,
    parameters: { id: z.uuid(), factType: humanStatementSchema.shape.factType },
    errors: [404, 503],
  },
  "post /api/projects/{id}/authority-policies": {
    status: 201,
    request: authorityPolicyChangeSchema,
    response: policyChangeResultSchema,
    parameters: { id: z.uuid() },
    errors: [404, 409, 503],
  },
  "post /api/projects/{id}/assessments": {
    status: 201,
    request: assessmentCaptureSchema,
    response: assessmentDeliverySchema,
    parameters: { id: z.uuid() },
    errors: [404, 409, 503],
  },
  "get /api/projects/{id}/assessments/{assessmentId}": {
    status: 200,
    response: assessmentDeliverySchema,
    parameters: { id: z.uuid(), assessmentId: z.uuid() },
    errors: [404, 503],
  },
  "get /api/project-setup": {
    status: 200,
    response: canonicalSetupSchema,
    errors: [503],
  },
  "post /api/portfolios/{id}/programmes": {
    status: 201,
    request: canonicalProgrammeCreateSchema,
    response: canonicalProgrammeSchema,
    parameters: { id: z.uuid() },
    errors: [404, 409, 503],
  },
  "post /api/projects": {
    status: 201,
    request: canonicalProjectCreateSchema,
    response: z.strictObject({ id: z.uuid() }),
    errors: [404, 409, 503],
  },
  "get /api/projects/{id}/canonical": {
    status: 200,
    response: canonicalProjectDetailSchema,
    parameters: { id: z.uuid() },
    errors: [404, 503],
  },
  "get /api/health/live": {
    status: 200,
    public: true,
    response: z.strictObject({ status: z.literal("ok") }),
  },
  "get /api/health/ready": {
    status: 200,
    public: true,
    errors: [503],
    response: z.strictObject({ status: z.literal("ok") }),
  },
  "get /api/auth/config": {
    status: 200,
    public: true,
    response: z.strictObject({
      mode: modes,
      dataMode: dataModes,
      scope: z.string().min(1),
      issuer: z.string().optional(),
      clientId: z.string().optional(),
      audience: z.string().optional(),
      resource: z.string().optional(),
    }),
  },
  "post /api/auth/development": {
    status: 200,
    public: true,
    errors: [400, 404],
    request: developmentSchema,
    response: z.strictObject({ token: z.string().min(1) }),
  },
  "get /api/me": {
    status: 200,
    response: z.strictObject({
      subject: z.string().min(1),
      roles: z.array(roleSchema),
      customerId: z.uuid(),
    }),
  },
  "get /api/projects": { status: 200, response: z.array(project) },
  "get /api/projects/{id}": {
    status: 200,
    errors: [404],
    parameters: { id: z.uuid() },
    response: project,
  },
  "get /api/platform": {
    status: 200,
    response: z.strictObject({
      database: z.enum(["connected", "unavailable"]),
      worker: z.enum(["running", "unavailable"]),
      heartbeat: z.iso.datetime().nullable(),
      shadowMode: z.boolean(),
      identityMode: modes,
      dataMode: dataModes,
    }),
  },
  "get /api/audit": {
    status: 200,
    response: z.array(
      z.strictObject({
        id: z.uuid(),
        event: z.string(),
        actor: z.string(),
        occurredAt: z.iso.datetime(),
      }),
    ),
  },
  "post /api/access-grants": {
    status: 204,
    request: grantSchema,
    errors: [400, 404],
  },
  "delete /api/access-grants": {
    status: 204,
    request: revokeSchema,
    errors: [400],
  },
};
export function wireSchema(schema: z.ZodType): SchemaObject {
  const generated = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    cycles: "throw",
    io: "input",
  });
  // OpenAPI 3.0 requires a type beside nullable. Preserve nullable unions as
  // their original alternatives plus a null-only branch, without weakening them.
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (value === null || typeof value !== "object") return value;
    const object = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalize(child)]),
    );
    if (object.nullable === true && object.type === undefined) {
      if (!Array.isArray(object.oneOf) && !Array.isArray(object.anyOf))
        throw new Error("Unsupported nullable OpenAPI schema");
      delete object.nullable;
      return {
        anyOf: [object, { type: "string", nullable: true, enum: [null] }],
      };
    }
    return object;
  }
  return normalize(generated) as SchemaObject;
}
export const errorMessages = {
  400: "Invalid request",
  401: "Sign-in required",
  403: "Access denied",
  404: "Resource unavailable",
  409: "Creation conflicts with an existing request or record",
  413: "Request body too large",
  415: "Unsupported media type",
  500: "Internal server error",
  503: "Service unavailable",
} as const;
export function isErrorStatus(
  status: unknown,
): status is keyof typeof errorMessages {
  return typeof status === "number" && Object.hasOwn(errorMessages, status);
}
const errorSchema = (status: number) => {
  if (!isErrorStatus(status)) throw new Error("Unregistered API error status");
  return z.strictObject({
    statusCode: z.literal(status),
    message: z.literal(errorMessages[status]),
  });
};
const response = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema: wireSchema(schema) } },
});
const methods = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

export function completeContract(document: OpenAPIObject) {
  const operations = new Map<string, OperationObject>();
  for (const [path, item] of Object.entries(document.paths))
    for (const method of methods)
      if (item[method]) operations.set(method + " " + path, item[method]);
  if (
    operations.size !== Object.keys(contracts).length ||
    [...operations.keys()].some((key) => !contracts[key])
  )
    throw new Error("API routes differ from registered contracts");
  for (const [key, contract] of Object.entries(contracts)) {
    const operation = operations.get(key);
    if (!operation) throw new Error("Missing API contract route");
    operation.security = contract.public ? [] : [{ bearer: [] }];
    operation.responses = {
      [contract.status]: contract.response
        ? response(contract.response, "Success")
        : { description: "Success; no response body" },
    };
    for (const status of new Set([
      400,
      413,
      415,
      500,
      ...(contract.public ? [] : [401, 403]),
      ...(contract.errors ?? []),
    ]))
      operation.responses[status] = response(
        errorSchema(status),
        "Request could not be completed",
      );
    if (contract.request)
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: wireSchema(contract.request) },
        },
      };
    if (contract.parameters)
      operation.parameters = Object.entries(contract.parameters).map(
        ([name, schema]) => ({
          name,
          in: "path",
          required: true,
          schema: wireSchema(schema),
        }),
      );
    if (contract.query)
      operation.parameters = [
        ...(operation.parameters ?? []),
        ...Object.entries(contract.query).map(([name, schema]) => ({
          name,
          in: "query" as const,
          required: false,
          schema: wireSchema(schema),
        })),
      ];
  }
  return document;
}

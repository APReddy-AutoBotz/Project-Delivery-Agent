import type { OpenAPIObject, SchemaObject } from "@nestjs/swagger";
export function completeContract(document: OpenAPIObject) {
  const string: SchemaObject = { type: "string" };
  const object = (
    properties: Record<string, SchemaObject>,
    required = Object.keys(properties),
  ): SchemaObject => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const project = object({
    id: { type: "string", format: "uuid" },
    portfolioId: { type: "string", format: "uuid" },
    code: string,
    name: string,
    description: string,
    reportedStatus: string,
  });
  const response = (schema: SchemaObject) => ({
    description: "Success",
    content: { "application/json": { schema } },
  });
  const shapes: Record<string, SchemaObject> = {
    "/api/health/live": object({ status: string }),
    "/api/health/ready": object({ status: string }),
    "/api/auth/config": object(
      {
        mode: { type: "string", enum: ["oidc", "development"] },
        dataMode: string,
        issuer: string,
        clientId: string,
        audience: string,
      },
      ["mode", "dataMode"],
    ),
    "/api/me": object({
      subject: string,
      roles: { type: "array", items: string },
      customerId: { type: "string", format: "uuid" },
    }),
    "/api/projects": { type: "array", items: project },
    "/api/projects/{id}": project,
    "/api/platform": object({
      database: string,
      worker: string,
      heartbeat: { type: "string", format: "date-time", nullable: true },
      shadowMode: { type: "boolean" },
      identityMode: string,
      dataMode: string,
    }),
    "/api/audit": {
      type: "array",
      items: object({
        id: string,
        event: string,
        actor: string,
        occurredAt: { type: "string", format: "date-time" },
      }),
    },
  };
  for (const [path, schema] of Object.entries(shapes)) {
    const operation = document.paths[path]?.get;
    if (!operation) throw new Error("Missing API contract route");
    operation.responses = {
      "200": response(schema),
      ...(path === "/api/health/ready"
        ? { "503": { description: "Database unavailable" } }
        : {}),
    };
    if (path.startsWith("/api/health/") || path === "/api/auth/config")
      operation.security = [];
    else
      Object.assign(operation.responses, {
        "401": { description: "Identity required" },
        "403": { description: "Permission denied" },
        "404": { description: "Resource unavailable" },
      });
  }
  const development = document.paths["/api/auth/development"]!.post!;
  development.security = [];
  development.responses = {
    "200": response(object({ token: string })),
    "400": { description: "Invalid persona" },
    "404": { description: "Development sign-in unavailable" },
  };
  return document;
}

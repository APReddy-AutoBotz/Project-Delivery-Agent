import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const jwks = createRemoteJWKSet(
  new URL("https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json"),
  { timeoutDuration: 1500 },
);

export const forgeJiraStagingBindingSchema = z.strictObject({
  appId: z.string().regex(/^ari:cloud:ecosystem::app\/[0-9a-f-]{36}$/),
  environmentId: z.string().regex(/^ari:cloud:ecosystem::environment\/[0-9a-f-]{36}(?:\/[0-9a-f-]{36})?$/),
  installationId: z.string().regex(/^ari:cloud:ecosystem::installation\/[0-9a-f-]{36}$/),
  cloudId: z.uuid(),
  jiraProjectId: z.string().regex(/^[1-9][0-9]{0,19}$/),
});

export type ForgeJiraStagingBinding = z.infer<typeof forgeJiraStagingBindingSchema>;

const invocationSchema = z.object({
  app: z.object({
    id: z.string(),
    environment: z.object({ id: z.string(), type: z.literal("STAGING") }),
    module: z.object({ type: z.literal("core:endpoint"), key: z.literal("jira-staging-project-probe") }),
    installationId: z.string().optional(),
    apiBaseUrl: z.string().optional(),
    installation: z.object({
      id: z.string(),
      contexts: z.array(z.object({
        name: z.string(),
        cloudId: z.string().optional(),
        apiBaseUrl: z.string(),
      })),
    }),
  }),
  context: z.object({ cloudId: z.string().optional() }).optional(),
  icLabel: z.undefined().optional(),
  jti: z.string().min(1).max(128),
  exp: z.number().int().positive(),
});

export function createForgeJiraInvocationVerifier(
  binding: ForgeJiraStagingBinding,
  key: JWTVerifyGetKey = jwks,
) {
  const apiBaseUrl = `https://api.atlassian.com/ex/jira/${binding.cloudId}`;
  return async (token: string) => {
    const { payload } = await jwtVerify(token, key, {
      issuer: "forge/invocation-token",
      audience: binding.appId,
      algorithms: ["RS256"],
      requiredClaims: ["iat", "nbf", "exp", "jti"],
    });
    const { app, context, jti, exp } = invocationSchema.parse(payload);
    const jira = app.installation.contexts.filter((entry) => entry.name === "jira");
    if (
      app.id !== binding.appId ||
      app.environment.id !== binding.environmentId ||
      app.installation.id !== binding.installationId ||
      (app.installationId !== undefined && app.installationId !== binding.installationId) ||
      (app.apiBaseUrl !== undefined && app.apiBaseUrl !== apiBaseUrl) ||
      (context?.cloudId !== undefined && context.cloudId !== binding.cloudId) ||
      jira.length !== 1 || jira[0]?.cloudId !== binding.cloudId || jira[0].apiBaseUrl !== apiBaseUrl
    ) throw new Error("FORGE_JIRA_INVOCATION_DENIED");
    return { id: jti, expiresAt: exp * 1000 };
  };
}

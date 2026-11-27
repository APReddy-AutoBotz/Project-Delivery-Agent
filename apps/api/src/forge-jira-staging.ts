import type { NestExpressApplication } from "@nestjs/platform-express";
import { JiraOAuthError, probeJiraCloudProject } from "@pdaa/connectors-jira";
import {
  createForgeJiraInvocationVerifier,
  forgeJiraStagingBindingSchema,
  readSecretFile,
  type ForgeJiraStagingBinding,
} from "@pdaa/platform";

const stagingPath = "/api/webhooks/forge/jira-staging";

type StagingRequest = {
  method: string;
  path: string;
  url: string;
  get(name: string): string | undefined;
};

type StagingResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): StagingResponse;
  json(body: { status: string }): void;
};

export function loadForgeJiraStagingBinding(path: string | undefined) {
  if (path === undefined) return null;
  try {
    const input: unknown = JSON.parse(readSecretFile(path, "PDAA_FORGE_JIRA_STAGING_FILE"));
    return forgeJiraStagingBindingSchema.parse(input);
  } catch {
    throw new Error("FORGE_JIRA_STAGING_CONFIGURATION");
  }
}

export function installForgeJiraStagingRoute(
  app: NestExpressApplication,
  binding: ForgeJiraStagingBinding | null,
  verify = binding ? createForgeJiraInvocationVerifier(binding) : undefined,
  fetchImpl: typeof fetch = fetch,
) {
  if (!binding || !verify) return;
  const recent = new Map<string, { expiresAt: number; result: Promise<number> }>();
  let retryAt = 0;

  function throttled(response: StagingResponse) {
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
    response.status(429).json({ status: "unavailable" });
  }

  app.use(async (request: StagingRequest, response: StagingResponse, next: () => void) => {
    if (request.path !== stagingPath || request.method !== "POST") {
      next();
      return;
    }
    if (request.url !== stagingPath) {
      response.status(400).json({ status: "unavailable" });
      return;
    }
    const authorization = request.get("authorization") ?? "";
    const token = request.get("x-forge-oauth-system") ?? "";
    const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(authorization);
    if (authorization.length > 12_288 || !match || token.length > 8192 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
      response.status(401).json({ status: "unavailable" });
      return;
    }
    let invocation: Awaited<ReturnType<typeof verify>>;
    try {
      invocation = await verify(match[1]!);
    } catch {
      response.status(401).json({ status: "unavailable" });
      return;
    }
    const now = Date.now();
    // Forge can repeat a delivery. A successful check is reusable only until its FIT expires.
    for (const [id, entry] of recent) {
      if (entry.expiresAt <= now) recent.delete(id);
    }
    let entry = recent.get(invocation.id);
    if (!entry) {
      if (retryAt > now || recent.size >= 64) {
        throttled(response);
        return;
      }
      const result = probeJiraCloudProject({
        cloudId: binding.cloudId,
        projectId: binding.jiraProjectId,
        accessToken: token,
        fetchImpl,
      }).then(() => 200, (error: unknown) => {
        if (error instanceof JiraOAuthError) {
          if (error.code === "RATE_LIMITED") {
            retryAt = Math.max(retryAt, Date.now() + (error.retryAfterMs ?? 60_000));
            return 429;
          }
          if (error.code === "PERMISSION_DENIED" || error.code === "INVALID_CREDENTIALS")
            return 403;
        }
        return 503;
      });
      entry = { expiresAt: invocation.expiresAt, result };
      recent.set(invocation.id, entry);
    }

    const status = await entry.result;
    if (status !== 200 && recent.get(invocation.id) === entry) recent.delete(invocation.id);
    if (status === 429) {
      throttled(response);
      return;
    }
    response.status(status).json({ status: status === 200 ? "reachable" : "unavailable" });
  });
}

import { z } from "zod";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192),
  expires_in: z.number().int().min(1).max(31_536_000),
  scope: z.string().max(2048).optional(),
}).passthrough();
const accessibleResourceSchema = z.array(z.object({
  id: z.string().min(1).max(128),
  url: z.url(),
  scopes: z.array(z.string().min(1).max(96)).max(64),
}).passthrough()).max(128);

export class JiraOAuthError extends Error {
  constructor(
    readonly code: "INVALID_CREDENTIALS" | "PERMISSION_DENIED" | "RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE" | "INVALID_RESPONSE",
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "JiraOAuthError";
  }
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit))
    throw new JiraOAuthError("INVALID_RESPONSE");
  if (!response.body) throw new JiraOAuthError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new JiraOAuthError("INVALID_RESPONSE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof JiraOAuthError) throw error;
    throw new JiraOAuthError("TEMPORARILY_UNAVAILABLE");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new JiraOAuthError("INVALID_RESPONSE");
  }
}

function retryAfterMs(response: Response, now = Date.now()): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay < 0) return null;
  return Math.min(Math.ceil(delay), 86_400_000);
}

function statusError(response: Response): JiraOAuthError {
  const { status } = response;
  if (status === 401 || status === 400) return new JiraOAuthError("INVALID_CREDENTIALS");
  if (status === 403) return new JiraOAuthError("PERMISSION_DENIED");
  if (status === 429) return new JiraOAuthError("RATE_LIMITED", retryAfterMs(response));
  if (status >= 500) return new JiraOAuthError("TEMPORARILY_UNAVAILABLE");
  return new JiraOAuthError("INVALID_RESPONSE");
}

export async function refreshJiraOAuthToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now?: number;
  fetchImpl?: typeof fetch;
}) {
  const clientId = z.string().min(1).max(1024).parse(input.clientId);
  const clientSecret = z.string().min(1).max(4096).parse(input.clientSecret);
  const refreshToken = z.string().min(1).max(8192).parse(input.refreshToken);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new JiraOAuthError("TEMPORARILY_UNAVAILABLE");
  }
  if (!response.ok) throw statusError(response);
  const raw = await readJson(response, 16_384);
  const parsed = tokenResponseSchema.safeParse(raw);
  if (!parsed.success) throw new JiraOAuthError("INVALID_RESPONSE");
  const scopes = parsed.data.scope?.split(/\s+/).filter(Boolean);
  if (scopes && (!scopes.includes("read:jira-work") || !scopes.includes("offline_access")))
    throw new JiraOAuthError("PERMISSION_DENIED");
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: new Date((input.now ?? Date.now()) + parsed.data.expires_in * 1000).toISOString(),
    ...(scopes ? { scopes } : {}),
  };
}

export async function getJiraAccessibleResources(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}) {
  const accessToken = z.string().min(1).max(8192).parse(input.accessToken);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)("https://api.atlassian.com/oauth/token/accessible-resources", {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new JiraOAuthError("TEMPORARILY_UNAVAILABLE");
  }
  if (!response.ok) throw statusError(response);
  const parsed = accessibleResourceSchema.safeParse(await readJson(response, 262_144));
  if (!parsed.success) throw new JiraOAuthError("INVALID_RESPONSE");
  return parsed.data.map((resource) => {
    const url = new URL(resource.url);
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== resource.url)
      throw new JiraOAuthError("INVALID_RESPONSE");
    return { cloudId: resource.id, url: resource.url, scopes: resource.scopes };
  });
}

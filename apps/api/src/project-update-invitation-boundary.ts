import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Actor } from "@pdaa/domain";
import type { IdentityService } from "@pdaa/platform";
import { errorMessages } from "./contract.js";

type Request = { url: string; method: string; actor?: Actor;
  headers: Record<string, string | string[] | undefined> };
type Response = { status(code: number): Response; json(value: unknown): void };

export function isProjectUpdateInvitationPath(url: string | undefined) {
  return /^\/api\/project-update-invitations\//i.test(url?.split("?", 1)[0] ?? "");
}

// Authenticate before the JSON parser. Bound memory and requests per current
// authenticated subject; no locators, credentials or response text in the map.
// One process is the deployment baseline; replicas each enforce this bound.
export function installProjectUpdateInvitationBoundary(
  app: Pick<NestExpressApplication, "use">,
  identity: Pick<IdentityService, "authenticate">,
  appOrigin: string,
  now: () => number = Date.now,
) {
  const windows = new Map<string, { expiresAt: number; count: number }>();
  app.use(async (req: Request, res: Response, next: () => void) => {
    if (!isProjectUpdateInvitationPath(req.url)) { next(); return; }
    const fail = (status: keyof typeof errorMessages) =>
      res.status(status).json({ statusCode: status, message: errorMessages[status] });
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) {
      fail(401); return;
    }
    try { req.actor = await identity.authenticate(header.slice(7)); }
    catch { fail(401); return; }
    const timestamp = now();
    for (const [key, window] of windows) if (window.expiresAt <= timestamp) windows.delete(key);
    const key = JSON.stringify([req.actor.customerId, req.actor.subject]);
    let window = windows.get(key);
    if (!window) {
      if (windows.size >= 5000) { fail(429); return; }
      window = { expiresAt: timestamp + 60000, count: 0 };
      windows.set(key, window);
    }
    if (++window.count > 60) { fail(429); return; }
    if (req.url.includes("?")) { fail(400); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== appOrigin) { fail(403); return; }
    if (req.method === "POST") {
      const encoding = req.headers["content-encoding"];
      const type = req.headers["content-type"];
      if ((encoding !== undefined && encoding !== "identity") || typeof type !== "string" ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
        fail(415); return;
      }
    }
    next();
  });
}

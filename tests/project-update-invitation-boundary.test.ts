// FR-UPD-006 / NFR-SEC-001: authenticate before parsers; fixed denial shapes.
import { describe, expect, it, vi } from "vitest";
import { installProjectUpdateInvitationBoundary, isProjectUpdateInvitationPath } from "../apps/api/src/project-update-invitation-boundary.js";

const origin = "https://customer.invalid";
const path = "/api/project-update-invitations/20000000-0000-4000-8000-000000000001/responses";
function fixture() {
  let handler: (req: unknown, res: unknown, next: () => void) => Promise<void>;
  let clock = 0;
  const authenticate = vi.fn(async () => ({ customerId: "10000000-0000-4000-8000-000000000001", subject: "recipient", roles: ["contributor"], synthetic: false }));
  installProjectUpdateInvitationBoundary({ use: (fn: typeof handler) => { handler = fn; } } as never,
    { authenticate } as never, origin, () => clock);
  return { authenticate, advance: () => { clock += 60000; }, invoke: async (headers: Record<string, string> = {}, url = path, method = "POST") => {
    const next = vi.fn(); const json = vi.fn(); let status = 0;
    const req = { headers, url, method };
    const res = { status: (value: number) => { status = value; return res; }, json };
    await handler!(req, res, next);
    return { status, json, next, req };
  } };
}
const headers = { authorization: "Bearer valid", "content-type": "application/json", origin };
describe("invitation boundary", () => {
  it.each([path, path.toUpperCase()])("protects Express case variants before parsing %s", async (url) => {
    const f = fixture();
    const result = await f.invoke({}, url);
    expect(isProjectUpdateInvitationPath(url)).toBe(true);
    expect(result.status).toBe(401); expect(result.next).not.toHaveBeenCalled();
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(result.json).toHaveBeenCalledWith({ statusCode: 401, message: "Sign-in required" });
  });
  it("authenticates before accepting an explicit JSON request", async () => {
    const f = fixture(), result = await f.invoke(headers);
    expect(f.authenticate).toHaveBeenCalledWith("valid");
    expect(result.req).toHaveProperty("actor.subject", "recipient");
    expect(result.next).toHaveBeenCalledOnce();
  });
  it.each(["gzip", "br", "deflate"])("rejects compressed %s bodies", async (encoding) => {
    expect((await fixture().invoke({ ...headers, "content-encoding": encoding })).status).toBe(415);
  });
  it.each(["text/plain", "application/x-www-form-urlencoded", "application/json; charset=iso-8859-1"])("rejects media type %s", async (type) => {
    expect((await fixture().invoke({ ...headers, "content-type": type })).status).toBe(415);
  });
  it("denies foreign origins and query parameters without calling the next boundary", async () => {
    const f = fixture();
    expect((await f.invoke({ ...headers, origin: "https://other.invalid" })).status).toBe(403);
    expect((await f.invoke(headers, path + "?recipient=other")).status).toBe(400);
  });
  it("limits the authenticated subject across locators and resets the expired window", async () => {
    const f = fixture();
    for (let index = 0; index < 60; index++) expect((await f.invoke(headers, path.replace("responses", String(index)))).next).toHaveBeenCalledOnce();
    const denied = await f.invoke(headers);
    expect(denied.status).toBe(429); expect(denied.next).not.toHaveBeenCalled();
    f.advance(); expect((await f.invoke(headers)).next).toHaveBeenCalledOnce();
  });
  it("denies rejected identity and passes unrelated routes untouched", async () => {
    const f = fixture(); f.authenticate.mockRejectedValueOnce(new Error("private token data"));
    expect((await f.invoke(headers)).status).toBe(401);
    expect((await f.invoke({}, "/api/projects")).next).toHaveBeenCalledOnce();
  });
});

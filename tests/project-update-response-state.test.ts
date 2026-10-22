import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { clearDeniedProjectUpdateInvitation } from "../apps/web/src/project-update-response-state.js";
const { QueryClient } = createRequire(new URL("../apps/web/package.json", import.meta.url))("@tanstack/react-query");

describe("denied invitation cache cleanup", () => {
  it.each([401, 403, 404])("erases only the exact protected invitation after HTTP %s", (status) => {
    const cache = new QueryClient();
    cache.setQueryData(["project-update-invitation", "own"], { body: "private request", escalationContext: { body: "private history" } });
    cache.setQueryData(["project-update-invitation", "another"], { body: "another invitation" });
    cache.setQueryData(["project-update-invitation", "own", "other"], { body: "separate key" });
    expect(clearDeniedProjectUpdateInvitation(cache, "own", { status })).toBe(true);
    expect(cache.getQueryData(["project-update-invitation", "own"])).toBeUndefined();
    expect(cache.getQueryData(["project-update-invitation", "another"])).toEqual({ body: "another invitation" });
    expect(cache.getQueryData(["project-update-invitation", "own", "other"])).toEqual({ body: "separate key" });
    cache.clear();
  });
  it.each([null, undefined, {}, { status: 503 }, { status: "403" }])("does not classify a transient or untyped failure as access denial (%j)", (error) => {
    const cache = new QueryClient();
    cache.setQueryData(["project-update-invitation", "own"], { body: "private request" });
    expect(clearDeniedProjectUpdateInvitation(cache, "own", error)).toBe(false);
    expect(cache.getQueryData(["project-update-invitation", "own"])).toEqual({ body: "private request" });
    cache.clear();
  });
});

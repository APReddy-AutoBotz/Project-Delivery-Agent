import { expect, it, vi } from "vitest";
import { closeCustomerBrowserSession } from "../scripts/acceptance/customer-session.mjs";

vi.mock("@playwright/test", () => ({
  expect: (locator: { isVisible: () => boolean; enabled: boolean }) => ({
    toBeVisible: async () => {
      if (!locator.isVisible()) throw new Error("Expected signed-out view");
    },
    toBeEnabled: async () => {
      if (!locator.enabled)
        throw new Error("Expected enabled organization sign-in");
    },
  }),
}));

const base = "https://web.example.test";
const issuer = "https://identity.example.test";
function fixture(fault = "none") {
  const events: string[] = [];
  let signedOut = fault === "expired";
  let requestReady = false,
    returnReady = false;
  const request = {
    url: () =>
      (fault === "origin" ? base : issuer) +
      "/identity/realms/pdaa/protocol/openid-connect/logout?state=public",
  };
  const frame = { url: () => base + (fault === "return" ? "/wrong" : "/") };
  const page = {
    mainFrame: () => frame,
    waitForRequest: vi.fn(
      async (predicate: (candidate: typeof request) => boolean) => {
        events.push("observe-logout");
        requestReady = true;
        if (!predicate(request)) throw new Error("Logout request not observed");
        return request;
      },
    ),
    waitForEvent: vi.fn(
      async (
        _event: string,
        options: { predicate: (candidate: typeof frame) => boolean },
      ) => {
        events.push("observe-return");
        returnReady = true;
        if (!options.predicate(frame))
          throw new Error("Expected return navigation");
        return frame;
      },
    ),
    waitForLoadState: vi.fn(async (state: string) => {
      events.push(state);
    }),
    getByRole: vi.fn(
      (role: string, options: { name: string; exact: boolean }) => ({
        isVisible: () =>
          options.name === "Sign out"
            ? !signedOut && fault !== "missing-control"
            : role === "heading" &&
              options.name === "Welcome to your workspace" &&
              signedOut,
        enabled:
          options.name === "Sign in with your organization" &&
          signedOut &&
          fault !== "disabled",
        click: async () => {
          expect(options).toEqual({ name: "Sign out", exact: true });
          expect(requestReady && returnReady).toBe(true);
          events.push("sign-out");
          if (fault === "click") throw new Error("Sign-out interaction failed");
          signedOut = true;
        },
      }),
    ),
  };
  const capture = Object.assign(
    vi.fn(async () => {
      events.push(signedOut ? "capture-signed-out" : "capture-protected");
      if (["capture", "both"].includes(fault))
        throw new Error("Original capture failed");
    }),
    {
      close: vi.fn(async () => {
        events.push("recorder-close");
        if (["close", "both"].includes(fault))
          throw new Error("Original close failed");
      }),
    },
  );
  return { session: { page, capture }, events };
}

it("FR-EVD-009 / SEC-SECRET-001: protected and signed-out captures surround real logout before recorder teardown", async () => {
  const f = fixture();
  await closeCustomerBrowserSession(f.session, base, issuer);
  expect(f.events).toEqual([
    "capture-protected",
    "observe-logout",
    "observe-return",
    "sign-out",
    "domcontentloaded",
    "capture-signed-out",
    "recorder-close",
  ]);
  expect(f.session.capture.close).toHaveBeenCalledTimes(1);
});
it("TR-AUTH-003: an already expired session must still prove the welcome and enabled organization sign-in views", async () => {
  const f = fixture("expired");
  await closeCustomerBrowserSession(f.session, base, issuer);
  expect(f.events).toEqual([
    "capture-signed-out",
    "domcontentloaded",
    "capture-signed-out",
    "recorder-close",
  ]);
  expect(f.session.page.waitForRequest).not.toHaveBeenCalled();
});
it.each([
  "origin",
  "return",
  "click",
  "missing-control",
  "disabled",
  "capture",
  "close",
  "both",
])(
  "SEC-SECRET-001: logout/capture failure remains fatal and recorder teardown is attempted (%s)",
  async (fault) => {
    const f = fixture(fault);
    const result = closeCustomerBrowserSession(f.session, base, issuer);
    if (fault === "both") {
      await expect(result).rejects.toMatchObject({
        name: "AggregateError",
        errors: [
          expect.objectContaining({ message: "Original capture failed" }),
          expect.objectContaining({ message: "Original close failed" }),
        ],
      });
    } else await expect(result).rejects.toThrow();
    expect(f.session.capture.close).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toBe("recorder-close");
  },
);

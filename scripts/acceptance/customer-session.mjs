// FR-EVD-009 / TR-AUTH-003 / SEC-SECRET-001: stop protected-view polling through
// the normal sign-out flow before destroying its disclosure target. This is
// fixture interaction, not a recorder exception or a response replacement.
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function closeCustomerBrowserSession(
  session,
  base,
  identityOrigin = "https://identity-ingress:8443",
) {
  if (!session) return;
  const { page, capture } = session;
  let primary;
  let cleanupError;
  try {
    // Preserve the final authorized/restricted view before logging out.
    await capture(page);
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    if (await signOut.isVisible()) {
      const logout = page.waitForRequest((request) =>
        request.url().includes("/protocol/openid-connect/logout?"),
      );
      const returned = page.waitForEvent("framenavigated", {
        predicate: (frame) =>
          frame === page.mainFrame() && frame.url() === base + "/",
      });
      // A failed click/navigation must not leave a rejected waiter unhandled.
      const completed = Promise.all([logout, returned]);
      void completed.catch(() => {});
      await signOut.click();
      const [request] = await completed;
      assert.equal(new URL(request.url()).origin, identityOrigin);
    }
    // A naturally ended session may already be here; never accept an arbitrary
    // absent sign-out control as proof that protected polling has stopped.
    await page.waitForLoadState("domcontentloaded");
    await expect(
      page.getByRole("heading", {
        name: "Welcome to your workspace",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Sign in with your organization",
        exact: true,
      }),
    ).toBeEnabled();
    await capture(page);
  } catch (error) {
    primary = error;
  }
  try {
    // Both pre/post-close recorder assertions remain mandatory, even if logout
    // or the preceding workflow failed. Missing original bytes cannot pass.
    await capture.close();
  } catch (error) {
    cleanupError = error;
  }
  if (primary && cleanupError)
    throw new AggregateError(
      [primary, cleanupError],
      "Customer session cleanup failed",
      { cause: primary },
    );
  if (cleanupError) throw cleanupError;
  if (primary) throw primary;
}

import assert from "node:assert/strict";
import { runWithOwnedCleanup } from "./role-bootstrap-readiness.mjs";

// Certificate-negative navigations intentionally fail. Use a fresh anonymous
// context so their expected network failure and close cannot contaminate the
// authenticated disclosure recorder.
export async function verifyIsolatedTlsRejection(browser, url, expectedError) {
  if (!["ERR_CERT_COMMON_NAME_INVALID", "ERR_CERT_AUTHORITY_INVALID"].includes(expectedError))
    throw new Error("Unsupported certificate rejection category");
  let context;
  try { context = await browser.newContext({ ignoreHTTPSErrors: false }); }
  catch { throw new Error("Certificate probe context unavailable"); }
  let responseCount = 0;
  await runWithOwnedCleanup(async () => {
    try {
      if ((await context.cookies()).length !== 0) throw new Error();
      const page = await context.newPage();
      page.on("response", () => { responseCount++; });
      let rejected = false, matching = false;
      try { await page.goto(url); }
      catch (error) {
        rejected = true;
        try { const message = error?.message; matching = typeof message === "string" && message.includes(expectedError); }
        catch { matching = false; }
      }
      assert(rejected && matching);
    } catch { throw new Error("Certificate probe failed"); }
  }, async () => {
    try { await context.close(); } catch { throw new Error("Certificate probe cleanup failed"); }
  }, () => console.error("Isolated TLS probe cleanup failed; the original failure is retained."));
  assert.equal(responseCount, 0, "Certificate rejection must not deliver a response");
}

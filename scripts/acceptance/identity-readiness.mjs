import { setTimeout as delay } from "node:timers/promises";

// A started container need not have finished importing its realm. Gate customer
// sign-in on discovery over its configured trusted HTTPS connection.
export async function waitForIdentityProvider(
  issuer,
  { timeoutMs = 120000, intervalMs = 500 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    let response;
    try {
      response = await fetch(issuer + "/.well-known/openid-configuration", {
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.min(4000, Math.max(1, deadline - Date.now())),
        ),
      });
    } catch {
      /* Retry transport startup only until the deadline. */
    }
    if (response) {
      if (response.status === 200) {
        let metadata;
        try {
          metadata = await response.json();
        } catch {
          /* Invalid below. */
        }
        if (metadata?.issuer !== issuer)
          throw new Error("Fixture identity discovery invalid");
        return;
      }
      await response.arrayBuffer();
    }
    await delay(intervalMs);
  } while (Date.now() < deadline);
  throw new Error("Fixture identity discovery unavailable");
}

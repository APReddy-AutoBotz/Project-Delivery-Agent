import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const fixtureSecretNames = [
  "admin-password",
  "api-password",
  "worker-password",
  "migration-password",
  "backup-password",
  "login-password",
  "backup-key",
  "encryption-key",
  "server.key",
  "ca.key",
  "connector-secret",
];
export const readFixtureSecrets = (directory) =>
  fixtureSecretNames.map((name) =>
    readFileSync(join(directory, name), "utf8").trim(),
  );

// SEC-SECRET-001: captures stay in memory. Errors and receipts contain no payload,
// credential value, token, URL or hash of a secret, including in a failed check.
export function createDisclosureCheck(initialSecrets) {
  const secrets = new Set();
  const channels = new Map();
  const addSecrets = (values) => {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((v) => typeof v !== "string" || v.length < 16)
    )
      throw new Error("Disclosure check requires generated secrets");
    for (const value of values) {
      const encoded = encodeURIComponent(value);
      for (const form of [
        value,
        JSON.stringify(value).slice(1, -1),
        encoded,
        encodeURIComponent(encoded),
        encoded.replace(/%[A-F0-9]{2}/g, (v) => v.toLowerCase()),
      ])
        secrets.add(form);
    }
  };
  addSecrets(initialSecrets);
  const serverSecrets = [...secrets];
  return {
    addSecrets,
    checkServerSecrets(text) {
      if (serverSecrets.some((secret) => text.includes(secret)))
        throw new Error("Secret disclosure detected");
    },
    add(channel, text) {
      if (typeof text !== "string")
        throw new Error("Disclosure capture unavailable");
      if (!channels.has(channel)) channels.set(channel, []);
      channels.get(channel).push(text);
    },
    verify(required) {
      for (const channel of required)
        if (!channels.get(channel)?.some((text) => text.length > 0))
          throw new Error("Required disclosure channel is empty");
      for (const entries of channels.values())
        for (const text of entries)
          for (const secret of secrets)
            if (text.includes(secret))
              throw new Error("Secret disclosure detected");
      return Object.fromEntries(
        [...channels].map(([name, entries]) => [
          name,
          {
            captures: entries.length,
            bytes: entries.reduce((n, text) => n + Buffer.byteLength(text), 0),
          },
        ]),
      );
    },
  };
}

// Observe product and configured fixture IdP outputs. Only the three credential
// fields of the exact token response are expected to deliver browser credentials.
export function observeBrowserDisclosure(
  context,
  origin,
  disclosure,
  identityOrigin = origin,
) {
  const pending = [];
  let failed = false;
  let tokenResponses = 0;
  const tokenUrl =
    identityOrigin + "/identity/realms/pdaa/protocol/openid-connect/token";
  const collect = (task) =>
    pending.push(
      task.catch(() => {
        failed = true;
      }),
    );
  context.on("response", (response) => {
    const url = new URL(response.url());
    if (![origin, identityOrigin].includes(url.origin)) return;
    collect(
      (async () => {
        disclosure.add(
          "browser-response-headers",
          JSON.stringify(await response.allHeaders()),
        );
        if (url.href === tokenUrl && response.status() === 200) {
          const tokens = await response.json();
          disclosure.checkServerSecrets(JSON.stringify(tokens));
          const { access_token, id_token, refresh_token, ...rest } = tokens;
          if (typeof access_token !== "string" || typeof id_token !== "string")
            throw new Error("Expected browser credentials unavailable");
          disclosure.addSecrets(
            [access_token, id_token, refresh_token].filter(
              (value) => typeof value === "string",
            ),
          );
          disclosure.add("identity-token-metadata", JSON.stringify(rest));
          tokenResponses++;
          return;
        }
        if (response.status() >= 300 && response.status() < 400) return;
        const body = await response.body();
        disclosure.add("browser-response-bodies", body.toString("utf8"));
      })(),
    );
  });
  context.on("page", (page) => {
    page.on("console", (message) => {
      disclosure.add("browser-console", message.text());
      collect(
        (async () => {
          for (const argument of message.args()) {
            const value = await argument.jsonValue();
            disclosure.add(
              "browser-console",
              JSON.stringify(value) ?? "undefined",
            );
          }
        })(),
      );
    });
    page.on("pageerror", (error) =>
      disclosure.add("browser-errors", error.stack ?? String(error)),
    );
  });
  return async (page) => {
    // Snapshot application state before navigating away or closing the context.
    disclosure.add("browser-dom", await page.content());
    disclosure.add(
      "browser-storage",
      JSON.stringify(
        await page.evaluate(() => ({
          local: { ...window.localStorage },
          session: { ...window.sessionStorage },
        })),
      ),
    );
    for (let start = 0; start < pending.length; ) {
      const end = pending.length;
      await Promise.all(pending.slice(start, end));
      start = end;
    }
    if (failed) throw new Error("Browser disclosure capture incomplete");
    if (!tokenResponses)
      throw new Error("Expected token response was not observed");
  };
}

export async function scanBrowserAssets(base, disclosure) {
  const get = async (path) => {
    const response = await fetch(base + "/" + path, {
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200)
      throw new Error("Shipped disclosure asset unavailable");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("Shipped disclosure asset empty");
    disclosure.add("asset-headers", JSON.stringify([...response.headers]));
    disclosure.add("assets", bytes.toString("utf8"));
    return bytes;
  };
  let manifest;
  const manifestBytes = await get("third-party-components.json");
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Shipped asset inventory unavailable");
  }
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.assets) ||
    !manifest.assets.length
  )
    throw new Error("Shipped asset inventory unavailable");
  for (const asset of manifest.assets) {
    if (
      typeof asset.file !== "string" ||
      !/^[A-Za-z0-9_./-]+$/.test(asset.file) ||
      asset.file.startsWith("/") ||
      asset.file.includes("..")
    )
      throw new Error("Invalid disclosure asset path");
    const bytes = await get(asset.file);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error("Disclosure asset differs from shipped inventory");
  }
  await get("THIRD_PARTY_NOTICES.txt");
  return manifest.assets.length + 2;
}

export function scanExecutionLogs(output, disclosure, prefix = "") {
  for (const file of readdirSync(output)) {
    if (
      !file.startsWith(prefix) ||
      !file.endsWith(".log") ||
      file.startsWith("build-")
    )
      continue;
    const text = readFileSync(join(output, file), "utf8");
    disclosure.add("execution-logs", text);
    rejectLoggedTokens(text);
  }
}

export function rejectLoggedTokens(text) {
  // Fixture OIDC uses signed JWTs. This also catches token values issued inside
  // the browser container without exporting them to the host's evidence bundle.
  if (/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/.test(text))
    throw new Error("Credential-shaped token disclosed in logs");
}

// The host does not own the container's private secret files. Check captured
// output inside the existing verifier instead of weakening fixture permissions
// or transmitting secret values through a command's stdout.
export function createHostDisclosure({
  output,
  run,
  command,
  runId,
  profile = "production",
}) {
  const captures = [];
  let sequence = 0;
  return {
    add(channel, text) {
      if (typeof text !== "string")
        throw new Error("Disclosure capture unavailable");
      captures.push({ channel, text });
    },
    verify(required) {
      const name = "disclosure-host-" + ++sequence;
      writeFileSync(
        join(output, name + ".input.json"),
        JSON.stringify({ captures, required }),
        { mode: 0o600 },
      );
      run(command(name), name);
      let receipt;
      try {
        receipt = JSON.parse(
          readFileSync(join(output, name + ".receipt.json"), "utf8"),
        );
      } catch {
        throw new Error("Host disclosure verification incomplete");
      }
      if (
        receipt.status !== "passed" ||
        receipt.runId !== runId ||
        receipt.profile !== profile ||
        receipt.phase !== name ||
        required.some((channel) => !(receipt.channels?.[channel]?.bytes > 0))
      )
        throw new Error("Host disclosure verification incomplete");
      return receipt.channels;
    },
  };
}

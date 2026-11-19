// Mounted read-only in the disposable packaged API, outside the shipped image.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConfiguredXlsxDecoder } from "/app/dist/xlsx-runtime.js";

const resolve = createRequire("/app/package.json").resolve;
const { createDatabase, DatabaseIngestionRepository } = await import(
  resolve("@pdaa/data")
);
const { CredentialVault, IsolatedXlsxDecoder, loadConfig } = await import(
  resolve("@pdaa/platform")
);
assert.match(
  process.env.PDAA_XLSX_PROOF_ID,
  /^pdaa-acceptance-\d+-[a-f0-9]{8}$/u,
);
const config = loadConfig(process.env);
assert.equal(config.CUSTOMER_ID, "10000000-0000-4000-8000-000000000002");
assert.equal(config.database.database, "pdaa");
assert(["database", "external-database"].includes(config.database.host));
assert.equal(config.database.user, "pdaa_api");
const adapter = createConfiguredXlsxDecoder(
  process.env.PDAA_XLSX_DECODER_MODE,
  config,
);
assert(adapter);
const inputs = JSON.parse(readFileSync("/proof/bindings.json", "utf8"));
const db = createDatabase(config.database);
const vault = new CredentialVault(config.ENCRYPTION_KEY);
let admissions = 0;
const writer = new DatabaseIngestionRepository(db, vault, {
  tryAcquire() {
    admissions++;
    return adapter.tryAcquire();
  },
});
const results = [];

try {
  assert.deepEqual(
    await db.$queryRaw`SELECT session_user::text AS role, ssl
    FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()`,
    [{ role: "pdaa_api", ssl: true }],
  );
  assert.deepEqual(inputs.map(({ profile }) => profile).sort(), [
    "excel-text-v1",
    "portable-v1",
  ]);
  for (const { profile, sourceId, subject } of inputs) {
    const actor = {
      customerId: config.CUSTOMER_ID,
      subject,
      roles: ["pmo_admin"],
    };
    const request = {
      sourceId,
      configRevision: 1,
      mappingRevision: 1,
      sheet: "Portfolio",
      commandKey: "fixture-packaged-xlsx-preview",
    };
    const bytes = readFileSync("/proof/" + profile + ".xlsx");
    const saved = await writer.persistXlsxPreview(
      actor,
      request,
      bytes,
      randomUUID(),
    );
    assert.equal(saved.replayed, false);
    assert.equal(saved.rowCount, 2);
    assert.deepEqual(
      await writer.persistXlsxPreview(actor, request, bytes, randomUUID()),
      { ...saved, replayed: true },
    );
    await assert.rejects(
      writer.persistXlsxPreview(
        actor,
        request,
        Buffer.from("different synthetic bytes"),
        randomUUID(),
      ),
      { code: "CONFLICT" },
    );
    results.push({
      profile,
      receiptId: saved.receiptId,
      workbookSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  assert.equal(admissions, 2);
  const wrongPeer = new IsolatedXlsxDecoder({
    bridge: "/usr/local/libexec/pdaa-xlsx-peer-bridge",
    socket: "/run/pdaa-xlsx/decoder.sock",
    peerUid: 1003,
    peerGid: 2000,
    timeoutMs: 2_000,
  });
  const lease = wrongPeer.tryAcquire();
  assert(lease);
  try {
    await assert.rejects(
      lease.decode(
        { sheet: "Portfolio", parserContract: "portable-v1" },
        readFileSync("/proof/portable-v1.xlsx"),
      ),
      /XLSX_DECODER_UNAVAILABLE/u,
    );
  } finally {
    lease.release();
  }
  assert.equal(wrongPeer.tryAcquire(), null);
  process.stdout.write(
    JSON.stringify({
      results,
      actualApiRole: true,
      tls: true,
      exactReplayWithoutAdmission: true,
      wrongPeerDenied: true,
    }) + "\n",
  );
} finally {
  await db.$disconnect();
}

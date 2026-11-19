// Synthetic Linux proof for the internal XLSX writer and its peer-checked client.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  DatabaseIngestionRepository,
} from "../../packages/data/dist/index.js";
import {
  CredentialVault,
  IsolatedXlsxDecoder,
} from "../../packages/platform/dist/index.js";
import { serve } from "../xlsx-isolation/server.mjs";
import {
  book,
  excelTextParts,
  fixtureParts,
} from "../../tests/fixtures/xlsx-test-worksheet.ts";
import { proveXlsxSourceGenesis } from "./xlsx-source-genesis.mjs";

export async function proveIsolatedXlsxPreviewWriter(
  pool,
  apiConnection,
  bridge,
) {
  const directory = await mkdtemp(join(tmpdir(), "pdaa-xlsx-"));
  const socket = join(directory, "decoder.sock");
  const options = {
    bridge,
    socket,
    peerUid: process.geteuid(),
    peerGid: process.getegid(),
    timeoutMs: 9_000,
  };
  let server;
  let unexpectedRetirement = false;
  const db = createDatabase(apiConnection);
  try {
    await new Promise((resolve, reject) => {
      server = serve(
        socket,
        "decode",
        (event) => {
          if (event === "READY") resolve();
        },
        () => {
          unexpectedRetirement = true;
          reject(new Error("Synthetic decoder retired"));
        },
      );
    });
    const decoder = new IsolatedXlsxDecoder(options);
    const vault = new CredentialVault(Buffer.alloc(32, 23).toString("base64"));
    const writer = new DatabaseIngestionRepository(db, vault, decoder);
    const replayOnly = new DatabaseIngestionRepository(db, vault);
    const {
      rows: [customer],
    } = await pool.query(
      'SELECT "customerId" FROM public."IngestionRetentionPolicy"',
    );
    assert(customer);
    assert.deepEqual(await db.$queryRaw`SELECT session_user::text AS name`, [
      { name: "pdaa_api" },
    ]);
    const canonicalFacts = async () =>
      (
        await pool.query(
          'SELECT count(*)::integer AS facts FROM public."ProjectFact" WHERE "customerId"=$1',
          [customer.customerId],
        )
      ).rows[0].facts;
    const factsBefore = await canonicalFacts();
    const profiles = [
      ["portable-v1", fixtureParts],
      ["excel-text-v1", excelTextParts],
    ];
    for (const [parserContract, parts] of profiles) {
      const sheet = "Portfolio";
      await proveXlsxSourceGenesis(pool, {
        retain: true,
        existingCustomer: customer.customerId,
        sheet,
        parserContract,
      });
      const { rows } = await pool.query(
        `SELECT h."sourceId", r."projectId", r.subject
         FROM public."IngestionXlsxHead" h JOIN public."IngestionConfigurationReader" r
         ON r."customerId"=h."customerId" AND r."sourceId"=h."sourceId" AND r."configRevision"=h."activationConfigRevision"
         JOIN public."IngestionConfigurationRevision" c
         ON c."customerId"=r."customerId" AND c."sourceId"=r."sourceId" AND c.revision=r."configRevision"
         WHERE h."customerId"=$1 AND c.mapping->>'sheet'=$2 AND c.mapping->>'parserContract'=$3`,
        [customer.customerId, sheet, parserContract],
      );
      assert.equal(rows.length, 1);
      const { sourceId, projectId, subject } = rows[0];
      const actor = {
        customerId: customer.customerId,
        subject,
        roles: ["pmo_admin"],
      };
      const request = {
        sourceId,
        configRevision: 1,
        mappingRevision: 1,
        sheet,
        commandKey: "isolated-synthetic-preview",
      };
      const values = [
        ["Key", "Project", "Status", "Forecast"],
        ["0001", projectId, "On track", "2027-03-02"],
        ["0002", projectId, "At risk", "2027-04-15"],
      ];
      const workbook = book(parts(values));
      const occupied = decoder.tryAcquire();
      assert(occupied);
      await assert.rejects(
        writer.persistXlsxPreview(actor, request, workbook, randomUUID()),
        { code: "PERSISTENCE_FAILED" },
      );
      occupied.release();

      const malformed = Buffer.from("synthetic non-workbook");
      await assert.rejects(
        writer.persistXlsxPreview(actor, request, malformed, randomUUID()),
        { code: "INVALID_REQUEST" },
      );
      const saved = await writer.persistXlsxPreview(
        actor,
        request,
        workbook,
        randomUUID(),
      );
      assert.equal(saved.replayed, false);
      assert.equal(saved.rowCount, 2);
      assert.deepEqual(
        await replayOnly.persistXlsxPreview(
          actor,
          request,
          workbook,
          randomUUID(),
        ),
        { ...saved, replayed: true },
      );
      await assert.rejects(
        replayOnly.persistXlsxPreview(actor, request, malformed, randomUUID()),
        { code: "CONFLICT" },
      );
      const { rows: outcomes } = await pool.query(
        `SELECT h.revision, x."workbookSha256", o.operation, p."factTypes"
         FROM public."IngestionXlsxHead" h JOIN public."IngestionXlsxContext" x ON x."receiptId"=h."currentReceiptId"
         JOIN public."IngestionRowOutcome" o ON o."receiptId"=x."receiptId"
         JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
         WHERE h."sourceId"=$1`,
        [sourceId],
      );
      assert.deepEqual(
        outcomes,
        Array.from({ length: 2 }, () => ({
          revision: 1,
          workbookSha256: createHash("sha256").update(workbook).digest("hex"),
          operation: "CREATE",
          factTypes: ["project.forecast", "project.status"],
        })),
      );
    }
    assert.equal(await canonicalFacts(), factsBefore);
    assert.equal(unexpectedRetirement, false);
    return {
      isolatedNativeProfiles: profiles.map(([profile]) => profile),
      exactReplayWithoutDecoder: true,
      proposalsOnly: true,
    };
  } finally {
    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      await db.$disconnect();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function proveXlsxPeerAndDeadline(bridge) {
  const directory = await mkdtemp(join(tmpdir(), "pdaa-xlsx-peer-"));
  const socket = join(directory, "peer.sock");
  const options = {
    bridge,
    socket,
    peerUid: process.geteuid(),
    peerGid: process.getegid(),
    timeoutMs: 500,
  };
  let observedBytes = 0;
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    sockets.add(connection);
    connection.on("data", (chunk) => {
      observedBytes += chunk.length;
    });
    connection.on("error", () => {});
    connection.once("close", () => sockets.delete(connection));
  });
  async function expectRetirement(decoder, signal) {
    const lease = decoder.tryAcquire();
    assert(lease);
    assert.equal(decoder.tryAcquire(), null);
    await assert.rejects(
      lease.decode(
        { sheet: "Portfolio", parserContract: "portable-v1" },
        book(fixtureParts()),
        signal,
      ),
      /XLSX_DECODER_UNAVAILABLE/u,
    );
    lease.release();
    assert.equal(decoder.tryAcquire(), null);
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await expectRetirement(
      new IsolatedXlsxDecoder({
        ...options,
        peerUid: options.peerUid === 0 ? 1 : 0,
      }),
    );
    assert.equal(observedBytes, 0);
    await expectRetirement(new IsolatedXlsxDecoder(options));
    assert(observedBytes > 0);
    const controller = new AbortController();
    const cancellation = () => controller.abort();
    server.once("connection", cancellation);
    try {
      await expectRetirement(
        new IsolatedXlsxDecoder(options),
        controller.signal,
      );
      assert.equal(controller.signal.aborted, true);
    } finally {
      server.removeListener("connection", cancellation);
    }
    return {
      wrongPeerReceivedNoBytes: true,
      deadlineRetiredClient: true,
      cancellationRetiredClient: true,
    };
  } finally {
    for (const connection of sockets) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

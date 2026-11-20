import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { serveDecoder } from "../scripts/xlsx-runtime/server.mjs";
import { stageProduction } from "../scripts/xlsx-runtime/stage-production.mjs";
import {
  decodeResult,
  encodeRejected,
  encodeRequest,
  readOneFrame,
  responseLimit,
} from "../packages/platform/src/xlsx-wire.js";
import {
  book,
  excelTextParts,
  fixtureParts,
  matrix,
} from "./fixtures/xlsx-test-worksheet.ts";

test("the allowlisted decoder context is reproducible and runs both profiles", () => {
  const root = mkdtempSync(join(tmpdir(), "pdaa-stage-"));
  try {
    const first = join(root, "first");
    const manifest = stageProduction(first);
    expect(stageProduction(join(root, "second"))).toEqual(manifest);
    expect(
      JSON.parse(readFileSync(join(first, "runtime/manifest.json"), "utf8")),
    ).toEqual(manifest);
    const paths = manifest.files.map(({ path }: { path: string }) => path);
    expect(paths).toContain("scripts/xlsx-runtime/worker.mjs");
    expect(paths).toContain("scripts/acceptance/xlsx-worksheet.mjs");
    expect(
      paths.filter((path: string) =>
        /(?:^scripts\/xlsx-isolation\/|^tests\/|^apps\/|^packages\/data\/)/u.test(
          path,
        ),
      ),
    ).toEqual([]);
    const worker = join(first, "runtime/scripts/xlsx-runtime/worker.mjs");
    const job = Buffer.alloc(16, 27);
    for (const [profile, parts] of [
      ["portable", fixtureParts()],
      ["excel-text-v1", excelTextParts()],
    ] as const) {
      const result = spawnSync(process.execPath, [worker], {
        input: encodeRequest(job, "Portfolio", book(parts), profile),
        env: {},
        timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(decodeResult(result.stdout, job)).toEqual({
        headers: matrix[0],
        rows: matrix.slice(1),
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(process.platform !== "linux")(
  "shutdown admits no second exchange and closes after the admitted worker settles",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pdaa-drain-"));
    const path = join(directory, "decoder.sock");
    const ready = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const worker = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let jobs = 0;
    const { server, drain } = serveDecoder({
      path,
      report: (event: string) => {
        if (event === "READY") ready.resolve();
      },
      retire: () => closed.reject(new Error("Unexpected decoder retirement")),
      async runWorker(_request: Buffer, job: Buffer) {
        jobs++;
        entered.resolve();
        await worker.promise;
        return { frame: encodeRejected(job), retire: false };
      },
    });
    function send(id: Buffer) {
      const client = createConnection({ path, allowHalfOpen: true });
      const reply = readOneFrame(client, responseLimit);
      client.end(
        encodeRequest(id, "Portfolio", Buffer.from("synthetic"), "portable"),
      );
      return reply;
    }
    try {
      await ready.promise;
      const firstId = Buffer.alloc(16, 1);
      const admitted = send(firstId);
      await entered.promise;
      drain((error?: Error) => {
        if (error) closed.reject(error);
        else closed.resolve();
      });
      await expect(send(Buffer.alloc(16, 2))).rejects.toThrow();
      expect(jobs).toBe(1);
      worker.resolve();
      expect(decodeResult(await admitted, firstId)).toBeNull();
      await closed.promise;
      expect(server.listening).toBe(false);
    } finally {
      worker.resolve();
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

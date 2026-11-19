import { lstatSync, readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { createConfiguredXlsxDecoder } from "../apps/api/src/xlsx-runtime.js";
import type { Config } from "../packages/platform/src/index.js";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(lstatSync).mockReset();
  vi.mocked(readFileSync).mockReset();
});

const config = {
  DEPLOYMENT_MODE: "customer",
  NODE_ENV: "production",
  database: {
    host: "database",
    port: 5432,
    database: "pdaa",
    user: "pdaa_api",
    password: "fixture",
    ssl: false,
  },
} satisfies Pick<Config, "DEPLOYMENT_MODE" | "NODE_ENV" | "database">;

test("the decoder requires an explicit customer API opt-in", () => {
  expect(createConfiguredXlsxDecoder(undefined, config)).toBeUndefined();
  for (const [mode, settings] of [
    ["true", config],
    ["isolated", { ...config, DEPLOYMENT_MODE: "local" }],
    ["isolated", { ...config, NODE_ENV: "test" }],
    [
      "isolated",
      { ...config, database: { ...config.database, user: "pdaa_migrate" } },
    ],
  ] as const) {
    expect(() => createConfiguredXlsxDecoder(mode, settings)).toThrow(
      "XLSX_DECODER_CONFIGURATION",
    );
  }
  expect(lstatSync).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== "linux")(
  "the opt-in fixes identity, executable and socket metadata",
  () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    vi.spyOn(process, "getgid").mockReturnValue(1000);
    const groups = vi.spyOn(process, "getgroups").mockReturnValue([1000, 2000]);
    function stat(
      kind: "file" | "directory" | "socket",
      uid: number,
      gid: number,
      mode: number,
    ) {
      return {
        uid,
        gid,
        mode,
        isFile: () => kind === "file",
        isDirectory: () => kind === "directory",
        isSocket: () => kind === "socket",
      } as ReturnType<typeof lstatSync>;
    }
    const known = [
      stat("file", 0, 0, 0o555),
      stat("directory", 1001, 2000, 0o750),
      stat("socket", 1001, 2000, 0o660),
    ];
    const mounts = vi
      .mocked(readFileSync)
      .mockReturnValue("12 9 0:1 / /run/pdaa-xlsx ro,nosuid - tmpfs tmpfs rw");
    const metadata = vi.mocked(lstatSync);
    for (const value of known) metadata.mockReturnValueOnce(value);
    expect(
      createConfiguredXlsxDecoder("isolated", config)?.tryAcquire(),
    ).toBeTruthy();
    expect(metadata.mock.calls.map(([path]) => path)).toEqual([
      "/usr/local/libexec/pdaa-xlsx-peer-bridge",
      "/run/pdaa-xlsx",
      "/run/pdaa-xlsx/decoder.sock",
    ]);
    metadata.mockReturnValueOnce(stat("file", 0, 0, 0o4555));
    for (const value of known.slice(1)) metadata.mockReturnValueOnce(value);
    expect(() => createConfiguredXlsxDecoder("isolated", config)).toThrow(
      "XLSX_DECODER_CONFIGURATION",
    );
    for (const value of known) metadata.mockReturnValueOnce(value);
    mounts.mockReturnValueOnce(
      "12 9 0:1 / /run/pdaa-xlsx rw,nosuid - tmpfs tmpfs rw",
    );
    expect(() => createConfiguredXlsxDecoder("isolated", config)).toThrow(
      "XLSX_DECODER_CONFIGURATION",
    );
    metadata.mockClear();
    groups.mockReturnValue([1000]);
    expect(() => createConfiguredXlsxDecoder("isolated", config)).toThrow(
      "XLSX_DECODER_CONFIGURATION",
    );
    expect(metadata).not.toHaveBeenCalled();
  },
);

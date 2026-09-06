import { expect, it } from "vitest";
import {
  checkArchitecture,
  loadWorkspace,
} from "../scripts/check-architecture.mjs";

type Fixture = {
  manifest: { name: string; dependencies: Record<string, string> };
  sources: Record<string, string>;
};

it("CI-FND-001: actual package and source boundaries are acyclic and expose public interfaces", () => {
  expect(checkArchitecture(loadWorkspace(process.cwd())).packages).toBe(6);
});
it("CI-FND-001: rejects dependency cycles, SDK leakage, private imports and alias bypasses", () => {
  const domain = (): Fixture => ({
    manifest: { name: "@pdaa/domain", dependencies: { zod: "4.5.4" } },
    sources: {
      "src/index.ts": 'import { z } from "zod"; export const id = z.string();',
    },
  });
  const platform = (): Fixture => ({
    manifest: {
      name: "@pdaa/platform",
      dependencies: { "@pdaa/domain": "workspace:*", jose: "6.2.12" },
    },
    sources: { "src/index.ts": 'import type { Actor } from "@pdaa/domain";' },
  });
  expect(checkArchitecture([domain(), platform()]).packages).toBe(2);
  const sdk = domain();
  sdk.manifest.dependencies["jose"] = "6.2.12";
  sdk.sources["src/index.ts"] = 'export type { JWTPayload } from "jose";';
  expect(() => checkArchitecture([sdk])).toThrow(/SDK/);
  const cycle = domain();
  cycle.manifest.dependencies["@pdaa/platform"] = "workspace:*";
  expect(() => checkArchitecture([cycle, platform()])).toThrow(/cycle/);
  for (const statement of [
    'import { id } from "@pdaa/domain/dist/index.js";',
    'export type { Actor } from "../../domain/src/index.js";',
    'type Actor = import("@pdaa/domain/src/index.js").Actor;',
    'const source = "jose"; import(source);',
    'const sdk = require("@pdaa/domain/src/index.js");',
  ]) {
    const candidate = platform();
    candidate.sources["src/index.ts"] = statement;
    expect(() => checkArchitecture([domain(), candidate])).toThrow();
  }
  expect(() =>
    checkArchitecture([
      { ...domain(), options: { paths: { hidden: ["../data"] } } },
    ]),
  ).toThrow(/aliases/);
  const files = domain();
  files.sources["src/index.ts"] = 'export * from "./other.js";';
  files.sources["src/other.ts"] = 'export * from "./index.js";';
  expect(() => checkArchitecture([files])).toThrow(/cycle/);
  const builtin = domain();
  builtin.sources["src/index.ts"] = 'import fs from "node:fs";';
  expect(() => checkArchitecture([builtin])).toThrow(/Infrastructure/);
});
it("CI-FND-001: worker tasks cannot import database infrastructure", () => {
  const packages = loadWorkspace(process.cwd());
  const worker = packages.find((pkg) => pkg.manifest.name === "@pdaa/worker")!;
  worker.sources["src/tasks.ts"] =
    'import { createDatabase } from "@pdaa/data";';
  expect(() => checkArchitecture(packages)).toThrow(/composition root/);
});

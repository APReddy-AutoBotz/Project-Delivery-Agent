import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const scripts = "scripts/acceptance";
const packages = new Map([
  ["saxes", "6.0.0"],
  ["xmlchars", "2.2.0"],
  ["yauzl", "3.4.0"],
  ["pend", "1.2.0"],
]);

export function stage(destination) {
  const files = [
    `${scripts}/xlsx-archive.mjs`,
    `${scripts}/xlsx-worksheet.mjs`,
    ...[
      "boundary",
      "caller",
      "server",
      "service",
      "supervise",
      "wire",
      "worker",
    ].map((name) => `scripts/xlsx-isolation/${name}.mjs`),
    "packages/platform/src/xlsx-wire.ts",
    "tests/fixtures/xlsx-test-worksheet.ts",
    "tests/fixtures/xlsx-test-archive.ts",
    "deploy/xlsx-isolation/Dockerfile",
  ];
  const virtualStore = realpathSync(join(root, "node_modules", ".pnpm"));
  const direct = {
    saxes: realpathSync(join(root, "node_modules", "saxes")),
    yauzl: realpathSync(join(root, "node_modules", "yauzl")),
  };
  const paths = {
    ...direct,
    xmlchars: realpathSync(join(dirname(direct.saxes), "xmlchars")),
    pend: realpathSync(join(dirname(direct.yauzl), "pend")),
  };
  for (const [name, version] of packages) {
    const source = paths[name];
    const location = relative(virtualStore, source);
    assert.equal(
      location,
      [`${name}@${version}`, "node_modules", name].join(sep),
    );
    const metadata = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    );
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, version);
    cpSync(source, join(destination, "node_modules", name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter(path) {
        const stat = lstatSync(path);
        assert(stat.isFile() || stat.isDirectory());
        return true;
      },
    });
  }
  for (const name of files) {
    const source = resolve(root, name);
    assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink());
    const output = join(destination, name);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(source, output);
  }
}

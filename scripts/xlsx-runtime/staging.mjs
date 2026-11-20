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
const packages = new Map([
  ["saxes", "6.0.0"],
  ["xmlchars", "2.2.0"],
  ["yauzl", "3.4.0"],
  ["pend", "1.2.0"],
]);

export const parserFiles = [
  "scripts/acceptance/xlsx-archive.mjs",
  "scripts/acceptance/xlsx-worksheet.mjs",
  "packages/platform/src/xlsx-wire.ts",
  ...["boundary", "parse", "server", "supervise", "wire"].map(
    (name) => "scripts/xlsx-runtime/" + name + ".mjs",
  ),
];

export function stageParserDependencies(destination) {
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
}

export function copySources(destination, files) {
  for (const name of files) {
    const source = resolve(root, name);
    assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink());
    const output = join(destination, name);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(source, output);
  }
}

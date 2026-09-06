// AC-MNT-004: retain original notices for the code actually bundled by Vite.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { Plugin } from "vite";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function thirdPartyEvidence(): Plugin {
  return {
    name: "pdaa-third-party-evidence",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const roots = new Map<string, Set<string>>();
        function recordModule(id: string) {
          if (!id.includes("node_modules") || id.startsWith("\0")) return;
          const file = realpathSync(id.split("?")[0]!);
          let path = dirname(file);
          while (true) {
            const manifest = join(path, "package.json");
            if (existsSync(manifest)) {
              const candidate = JSON.parse(readFileSync(manifest, "utf8")) as {
                name?: string;
                version?: string;
              };
              if (candidate.name && candidate.version) break;
            }
            const parent = dirname(path);
            if (parent === path)
              throw new Error("Bundled package manifest is absent");
            path = parent;
          }
          const modules = roots.get(path) ?? new Set<string>();
          modules.add(relative(path, file).replaceAll("\\", "/"));
          roots.set(path, modules);
        }
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk")
            for (const id of Object.keys(output.modules)) recordModule(id);
        }
        // Tailwind produces shipped styles before Rollup's module graph is built.
        recordModule(createRequire(import.meta.url).resolve("tailwindcss"));
        const components = [...roots]
          .map(([root, modules]) => {
            const pkg = JSON.parse(
              readFileSync(join(root, "package.json"), "utf8"),
            ) as { name: string; version: string; license?: string };
            if (!pkg.name || !pkg.version)
              throw new Error("Bundled package identity is absent");
            const notices: {
              path: string;
              sha256: string;
              contents: string;
            }[] = [];
            function walk(path: string) {
              for (const entry of readdirSync(path, { withFileTypes: true })) {
                if (entry.name === "node_modules") continue;
                const file = join(path, entry.name);
                if (entry.isDirectory()) walk(file);
                else if (
                  /^(licen[sc]e|notice|copyright)([._-]|$)/i.test(entry.name)
                ) {
                  const physical = realpathSync(file);
                  const local = relative(root, physical);
                  if (local.startsWith("..") || isAbsolute(local))
                    throw new Error("Notice escapes its package");
                  const bytes = readFileSync(file);
                  notices.push({
                    path: relative(root, file).replaceAll("\\", "/"),
                    sha256: hash(bytes),
                    contents: bytes.toString("base64"),
                  });
                }
              }
            }
            walk(root);
            if (!notices.length)
              throw new Error(
                `Original bundled notices are absent: ${pkg.name}`,
              );
            return {
              name: pkg.name,
              version: pkg.version,
              license: pkg.license ?? "UNKNOWN",
              modules: [...modules].sort(),
              notices: notices.sort((a, b) => a.path.localeCompare(b.path)),
            };
          })
          .sort((a, b) =>
            `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
          );
        const assets = Object.values(bundle)
          .map((output) => ({
            file: output.fileName,
            sha256: hash(output.type === "chunk" ? output.code : output.source),
          }))
          .sort((a, b) => a.file.localeCompare(b.file));
        this.emitFile({
          type: "asset",
          fileName: "third-party-components.json",
          source:
            JSON.stringify({ schemaVersion: 1, components, assets }, null, 2) +
            "\n",
        });
        this.emitFile({
          type: "asset",
          fileName: "THIRD_PARTY_NOTICES.txt",
          source:
            components
              .map(
                (p) =>
                  `${p.name} ${p.version}\n${p.notices.map((n) => `${n.path}\n${Buffer.from(n.contents, "base64").toString("utf8")}`).join("\n\n")}`,
              )
              .join("\n\n----------------------------------------\n\n") + "\n",
        });
      },
    },
  };
}

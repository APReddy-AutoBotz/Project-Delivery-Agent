// NFR-MNT-002 / CI-FND-001. Conventions for first-party source, not a code sandbox.
import ts from "typescript";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { resolve, join, posix } from "node:path";
import { isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";

const policies = {
  "@pdaa/operations": {
    workspace: ["@pdaa/platform"],
    external: ["pg", "graphile-worker"],
    node: true,
  },
  "@pdaa/domain": { workspace: [], external: ["zod"] },
  "@pdaa/platform": {
    workspace: ["@pdaa/domain"],
    external: ["zod", "jose"],
    node: true,
  },
  "@pdaa/data": {
    workspace: ["@pdaa/domain", "@pdaa/platform"],
    external: ["@prisma/client", "@prisma/adapter-pg", "pg"],
    node: true,
  },
  "@pdaa/api": {
    workspace: ["@pdaa/domain", "@pdaa/platform", "@pdaa/data"],
    external: [
      "@nestjs/common",
      "@nestjs/core",
      "@nestjs/platform-express",
      "@nestjs/swagger",
      "reflect-metadata",
      "rxjs",
      "zod",
    ],
    node: true,
  },
  "@pdaa/worker": {
    workspace: ["@pdaa/domain", "@pdaa/platform", "@pdaa/data"],
    external: ["pg", "graphile-worker"],
    node: true,
  },
  "@pdaa/web": {
    workspace: [],
    external: ["react", "react-dom", "@tanstack/react-query", "oidc-client-ts"],
  },
};
const packageName = (specifier) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];

export function assertAcyclic(graph) {
  const visiting = new Set(),
    visited = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error("Architecture cycle: " + name);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name);
}

function imports(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length)
    throw new Error("Invalid TypeScript source: " + file);
  if (source.referencedFiles.length || source.typeReferenceDirectives.length)
    throw new Error("Reference directives bypass package imports: " + file);
  const found = [];
  const literal = (node) => {
    if (
      !node ||
      !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    )
      throw new Error("Computed module loading is not allowed: " + file);
    found.push(node.text);
  };
  function walk(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) literal(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument))
        throw new Error("Computed import type: " + file);
      literal(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      literal(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return found;
}

export function checkArchitecture(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  if (byName.size !== packages.length)
    throw new Error("Duplicate workspace package");
  const graph = new Map(
    packages.map((pkg) => [
      pkg.manifest.name,
      new Set(
        Object.keys({
          ...pkg.manifest.dependencies,
          ...pkg.manifest.devDependencies,
        }).filter((name) => byName.has(name)),
      ),
    ]),
  );
  assertAcyclic(graph);
  let count = 0;
  for (const pkg of packages) {
    const name = pkg.manifest.name,
      policy = policies[name];
    if (!policy) throw new Error("Unreviewed workspace boundary: " + name);
    if (
      pkg.manifest.imports ||
      pkg.options?.paths ||
      pkg.options?.baseUrl ||
      pkg.options?.rootDirs?.length
    )
      throw new Error(
        "Module aliases bypass workspace public interfaces: " + name,
      );
    for (const dependency of graph.get(name))
      if (!policy.workspace.includes(dependency))
        throw new Error(
          "Forbidden workspace dependency: " + name + " -> " + dependency,
        );
    const fileGraph = new Map();
    for (const [file, content] of Object.entries(pkg.sources)) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      if (!/\.tsx?$/.test(file))
        throw new Error(
          "Runtime source must be TypeScript: " + name + "/" + file,
        );
      count++;
      const edges = new Set();
      fileGraph.set(file, edges);
      const task = name === "@pdaa/worker" && file !== "src/main.ts";
      for (const specifier of imports(file, content)) {
        if (specifier.startsWith(".")) {
          const target = posix.normalize(
            posix.join(posix.dirname(file), specifier),
          );
          if (!target.startsWith("src/") || target.includes("/node_modules/"))
            throw new Error(
              "Relative import bypasses package boundary: " +
                file +
                " -> " +
                specifier,
            );
          if (
            name === "@pdaa/data" &&
            target.startsWith("src/generated/prisma/")
          )
            continue;
          const stem = target.replace(/\.js$/, "");
          const destination = [
            target,
            stem + ".ts",
            stem + ".tsx",
            stem + ".d.ts",
            target + "/index.ts",
          ].find((value) => Object.hasOwn(pkg.sources, value));
          if (!destination)
            throw new Error(
              "Unresolved source import: " + file + " -> " + specifier,
            );
          if (/\.tsx?$/.test(destination)) edges.add(destination);
          continue;
        }
        if (isBuiltin(specifier)) {
          if (!policy.node || task)
            throw new Error(
              "Infrastructure import outside adapter: " +
                file +
                " -> " +
                specifier,
            );
          continue;
        }
        const dependency = packageName(specifier);
        if (!Object.hasOwn(pkg.manifest.dependencies ?? {}, dependency))
          throw new Error(
            "Undeclared runtime import: " + file + " -> " + specifier,
          );
        if (byName.has(dependency)) {
          if (
            specifier !== dependency ||
            !policy.workspace.includes(dependency)
          )
            throw new Error(
              "Private workspace import: " + file + " -> " + specifier,
            );
          if (
            (name === "@pdaa/api" &&
              dependency === "@pdaa/data" &&
              file !== "src/main.ts") ||
            (task && dependency !== "@pdaa/domain")
          )
            throw new Error(
              "Infrastructure dependency outside composition root: " + file,
            );
        } else if (!policy.external.includes(dependency) || task) {
          throw new Error(
            "External SDK outside approved adapter: " +
              file +
              " -> " +
              specifier,
          );
        }
      }
    }
    assertAcyclic(fileGraph);
  }
  return { packages: packages.length, sourceFiles: count };
}

export function loadWorkspace(root) {
  return ["apps", "packages"].flatMap((group) =>
    readdirSync(join(root, group)).map((dir) => {
      const base = join(root, group, dir),
        sources = {};
      const manifest = JSON.parse(
        readFileSync(join(base, "package.json"), "utf8"),
      );
      const parsed = ts.getParsedCommandLineOfConfigFile(
        join(base, "tsconfig.json"),
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => {
            throw new Error("Invalid workspace TypeScript configuration");
          },
        },
      );
      if (!parsed || parsed.errors.length)
        throw new Error("Invalid workspace TypeScript configuration");
      function walk(relative) {
        for (const entry of readdirSync(join(base, relative))) {
          if (
            manifest.name === "@pdaa/data" &&
            relative === "src" &&
            entry === "generated"
          )
            continue;
          const path = posix.join(relative, entry),
            stat = lstatSync(join(base, path));
          if (stat.isSymbolicLink())
            throw new Error("Source symlinks bypass package boundaries");
          if (stat.isDirectory()) walk(path);
          else sources[path] = readFileSync(join(base, path), "utf8");
        }
      }
      walk("src");
      return { manifest, sources, options: parsed.options };
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    "Architecture boundaries verified: " +
      JSON.stringify(
        checkArchitecture(loadWorkspace(resolve(import.meta.dirname, ".."))),
      ),
  );

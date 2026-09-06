// Packaging guard, not a complete legal notice or vulnerability gate (STORY-004).
import {
  readdirSync,
  realpathSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
const root = realpathSync(resolve(process.argv[2]));
const denied = new Set([
  "prisma",
  "@prisma/dev",
  "@prisma/studio-core",
  "elkjs",
  "typescript",
  "vite",
  "vitest",
  "@playwright/test",
  "tailwindcss",
]);
const seen = new Set();
const packages = new Map();
const roots = new Map();
function walk(path) {
  const physical = realpathSync(path);
  const local = relative(root, physical);
  if (
    local === ".." ||
    local.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) ||
    isAbsolute(local)
  )
    throw new Error("Runtime dependency escapes the deployment directory");
  if (seen.has(physical)) return;
  seen.add(physical);
  const manifest = join(physical, "package.json");
  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.name && pkg.version) {
      roots.set(pkg.name, physical);
      if (denied.has(pkg.name))
        throw new Error("Build-only dependency in runtime image: " + pkg.name);
      packages.set(pkg.name + "@" + pkg.version, {
        name: pkg.name,
        version: pkg.version,
        license:
          pkg.license ??
          (pkg.name.startsWith("@pdaa/") ? "proprietary" : "review-required"),
      });
    }
  }
  for (const entry of readdirSync(physical, { withFileTypes: true })) {
    const child = join(physical, entry.name);
    if (entry.isDirectory()) walk(child);
    else if (entry.isSymbolicLink()) {
      // Resolve even file links to enforce the containment boundary.
      const destination = realpathSync(child);
      const target = relative(root, destination);
      if (target.startsWith("..") || isAbsolute(target))
        throw new Error("Runtime symlink escapes deployment");
    }
  }
}
if (!existsSync(join(root, "dist/main.js")))
  throw new Error("Runtime application entrypoint absent");
walk(root);
for (const name of ["@pdaa/data", "@pdaa/platform", "@pdaa/domain"]) {
  const target = roots.get(name);
  if (!target || !existsSync(join(target, "dist/index.js")))
    throw new Error("Compiled workspace dependency absent");
}
const inventory = {
  packages: [...packages.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  ),
  distributionAccepted: false,
};
writeFileSync(
  join(root, "runtime-inventory.json"),
  JSON.stringify(inventory, null, 2) + "\n",
);
console.log(
  `Runtime packaging guard passed: ${packages.size} package versions; build-only tools absent. Distribution review remains required.`,
);

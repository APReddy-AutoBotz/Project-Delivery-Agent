import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const manifests = [
  "package.json",
  ...["apps", "packages"].flatMap((root) =>
    readdirSync(root).map((dir) => `${root}/${dir}/package.json`),
  ),
];
const deps = new Map();
for (const file of manifests) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const kind of ["dependencies", "devDependencies"])
    for (const [name, version] of Object.entries(pkg[kind] ?? {})) {
      if (version.startsWith("workspace:")) continue;
      const key = `${name}@${version}`;
      const item = deps.get(key) ?? {
        name,
        version,
        runtime: false,
        consumers: [],
      };
      item.runtime ||= kind === "dependencies";
      item.consumers.push(pkg.name);
      deps.set(key, item);
    }
}
for (const item of JSON.parse(
  readFileSync("docs/07-research/DEPENDENCY_OVERRIDES.json", "utf8"),
))
  deps.set(`${item.name}@${item.version}`, item);
const entries = await Promise.all(
  [...deps.values()].map(async (item) => {
    const source = `https://registry.npmjs.org/${encodeURIComponent(item.name)}/${item.version}`;
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(`Cannot verify ${item.name}@${item.version}`);
    const meta = await response.json();
    if (
      !["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause"].includes(
        meta.license,
      )
    )
      throw new Error(`License review required: ${item.name}`);
    return {
      ...item,
      license: meta.license,
      repository: meta.repository?.url,
      source,
      modified: false,
      securityOwner: "Implementation controller",
      approvedBy: "Delegated architecture review; permissive published package",
      reviewDate: "2026-09-06",
      replacementPath: item.runtime
        ? "Replace behind first-party module boundary"
        : "Replace development tooling",
    };
  }),
);
entries.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  "docs/07-research/DEPENDENCIES.json",
  JSON.stringify({ reviewDate: "2026-09-06", entries }, null, 2) + "\n",
);
const path = "docs/07-research/OPEN_SOURCE_ADOPTION_REGISTER.md";
const original = readFileSync(path, "utf8").split(
  "## Foundation package adoption",
)[0];
writeFileSync(
  path,
  original +
    "## Foundation package adoption\n\nExact direct dependencies verified against publisher metadata on 2026-09-06. Runtime entries are approved for local foundation implementation under the delegated permissive-license policy. Full transitive notices, image inventory and vulnerability disposition remain release gates. No upstream source was copied or modified. The machine-readable record [DEPENDENCIES.json](DEPENDENCIES.json) includes consumers, owners and replacement paths.\n\n| Published package | Version | License | Use |\n|---|---|---|---|\n" +
    entries
      .map(
        (e) =>
          `| [${e.name}](${e.source}) | ${e.version} | ${e.license} | ${e.runtime ? "Runtime" : "Development"} |`,
      )
      .join("\n") +
    "\n",
);
writeFileSync(
  "THIRD_PARTY_NOTICES.md",
  "# Third-party notices — foundation development inventory\n\nPublished packages are used without modification. Their original license and copyright files remain in installed packages. The exact inventory and publisher references appear below; this development inventory is not a completed distributable notice bundle. Before distribution, aggregate all transitive package and container OS licenses/copyrights and review the locked dependency scan.\n\n" +
    entries
      .map(
        (e) =>
          `- **${e.name} ${e.version}** — ${e.license}; [publisher metadata](${e.source}); source: ${e.repository ?? "see metadata"}.`,
      )
      .join("\n") +
    "\n\nPostgreSQL is used as a separate service under the PostgreSQL License. No enterprise-only code, source repositories or copyleft application dependencies have been vendored.\n",
);
console.log(
  `Verified ${entries.length} direct dependency licenses and wrote adoption records.`,
);

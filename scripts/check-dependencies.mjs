// NFR-MNT-004 / CI-MNT-004 (direct package registration portion only).
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export function checkDependencies(manifests, entries, overrides = []) {
  const wanted = new Map();
  for (const manifest of manifests)
    for (const kind of ["dependencies", "devDependencies"])
      for (const [name, version] of Object.entries(manifest[kind] ?? {})) {
        if (version.startsWith("workspace:")) continue;
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
          throw new Error("Exact dependency version required: " + name);
        const key = name + "@" + version;
        wanted.set(key, (wanted.get(key) ?? false) || kind === "dependencies");
      }
  for (const entry of overrides)
    wanted.set(entry.name + "@" + entry.version, entry.runtime);
  const registered = new Map();
  for (const entry of entries) {
    const key = entry.name + "@" + entry.version;
    if (registered.has(key))
      throw new Error("Duplicate dependency record: " + key);
    if (
      !["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause"].includes(
        entry.license,
      )
    )
      throw new Error("License review required: " + key);
    if (
      !entry.approvedBy ||
      !entry.reviewDate ||
      !entry.securityOwner ||
      !entry.replacementPath
    )
      throw new Error("Incomplete dependency review: " + key);
    registered.set(key, entry.runtime);
  }
  if (registered.size !== wanted.size)
    throw new Error("Dependency register differs from manifests");
  for (const [key, runtime] of wanted)
    if (!registered.has(key) || registered.get(key) !== runtime)
      throw new Error("Unregistered or misclassified dependency: " + key);
  return wanted.size;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const json = (path) => JSON.parse(readFileSync(path, "utf8"));
  const manifests = [
    json("package.json"),
    ...["apps", "packages"].flatMap((root) =>
      readdirSync(root).map((dir) => json(`${root}/${dir}/package.json`)),
    ),
  ];
  const total = checkDependencies(
    manifests,
    json("docs/07-research/DEPENDENCIES.json").entries,
    json("docs/07-research/DEPENDENCY_OVERRIDES.json"),
  );
  console.log(
    `${total} exact direct/override dependency records verified. Transitive/image distribution review remains a separate gate.`,
  );
}

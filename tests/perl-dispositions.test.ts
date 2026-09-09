import { describe, expect, it } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../scripts/distribution/evidence.mjs";
import { readBoundedNodeFile } from "../scripts/distribution/node-supplemental.mjs";
import {
  canonical,
  capturePerlScopeFacts,
  derivePerlDispositions,
  deriveReviewedPerlRows,
  readPerlAnchor,
  validatePerlAnchors,
  perlAnchorLimit,
} from "../scripts/distribution/perl-dispositions.mjs";
import {
  composeDispositionReports,
  readDispositionAnchor,
  dispositionLedgerLimit,
} from "../scripts/distribution/vulnerability-dispositions.mjs";
const policyBytes = readFileSync(
  "scripts/distribution/perl-disposition-policy.json",
);
const analysisBytes = readFileSync(
  "scripts/distribution/perl-static-analysis.json",
);
const realPolicy = JSON.parse(policyBytes.toString());
const realAnalysis = JSON.parse(analysisBytes.toString());
const encode = (v: any) => Buffer.from(JSON.stringify(v));
function fixture(target = "api", scope = "squashed"): any {
  const layerID = "sha256:" + hash("base");
  const inspection = {
    Id: "sha256:" + hash("image"),
    RootFS: { Layers: [layerID, "sha256:" + hash("later")] },
  };
  const original = structuredClone(
    realAnalysis.packages.find((p: any) => p.name === "perl-base"),
  );
  // All actual material pins are used; synthetic ownership/metadata keeps fixtures small.
  const pkg = {
    id: "perl-base",
    name: "perl-base",
    version: original.version,
    type: "deb",
    purl: "pkg:deb/debian/perl-base@test",
    metadata: {
      source: "perl",
      architecture: "amd64",
      files: original.material.map((m: any) => ({ path: m.path })),
    },
    locations: [{ path: "/var/lib/dpkg/status", layerID }],
  };
  const files = original.material.map((m: any, i: number) => ({
    id: "file" + i,
    location: { path: m.path, layerID },
    metadata: { type: "RegularFile", size: m.size },
    digests: [{ algorithm: "sha256", value: m.sha256 }],
    ...(m.elf
      ? { executable: { format: "elf", importedLibraries: [...m.elf.needed] } }
      : {}),
  }));
  const sbom = {
    source: { id: "source", metadata: { imageID: inspection.Id } },
    descriptor: { configuration: { search: { scope } } },
    artifacts: [pkg],
    files,
    artifactRelationships: files.map((f: any) => ({
      parent: pkg.id,
      child: f.id,
      type: "contains",
    })),
  };
  const analysis = { packages: [original] };
  const match = {
    vulnerability: structuredClone(realPolicy.rule.advisory),
    artifact: structuredClone(pkg),
    matchDetails: [{ matcher: "dpkg-matcher" }],
  };
  const scan = {
    matches: [
      match,
      {
        artifact: structuredClone(pkg),
        vulnerability: {
          id: "CVE-2026-13221",
          namespace: realPolicy.rule.advisory.namespace,
        },
      },
      structuredClone(match),
    ],
  };
  const { facts, normalize } = capturePerlScopeFacts({
    inspection,
    sbom,
    analysis,
  });
  const policy = {
    ...structuredClone(realPolicy),
    inputs: [
      {
        target,
        scope,
        packageNames: [pkg.name],
        fileCount: facts.files.length,
        factsSha256: hash(canonical(facts)),
        matchArtifacts: { [pkg.name]: hash(canonical(normalize(pkg))) },
        matchEnvelopes: {
          [pkg.name]: hash(
            canonical(normalize({ matchDetails: match.matchDetails })),
          ),
        },
      },
    ],
  };
  return { target, inspection, sbom, scan, analysis, policy };
}
describe("Perl architecture evidence (NFR-SEC-010 / AC-MNT-004)", () => {
  it("collects the real bounded anchors and rejects a replaced authority", () => {
    expect(readPerlAnchor("perl-disposition-policy.json")).toEqual(policyBytes);
    expect(readDispositionAnchor("perl-static-analysis.json")).toEqual(
      analysisBytes,
    );
    expect(() => validatePerlAnchors(policyBytes, analysisBytes)).not.toThrow();
    expect(policyBytes.length).toBeLessThan(perlAnchorLimit);
    expect(analysisBytes.length).toBeLessThan(perlAnchorLimit);
    const changed = structuredClone(realAnalysis);
    changed.packages.find((p: any) => p.material.length).material[0].elf.class =
      32;
    const changedPolicy = {
      ...realPolicy,
      analysisSha256: hash(canonical(changed)),
    };
    expect(() =>
      validatePerlAnchors(encode(changedPolicy), encode(changed)),
    ).toThrow(/trusted checkout/);
    expect(() => validatePerlAnchors(policyBytes, encode(changed))).toThrow(
      /trusted checkout/,
    );
    expect(() =>
      validatePerlAnchors(
        encode({
          ...realPolicy,
          rule: {
            ...realPolicy.rule,
            advisory: { ...realPolicy.rule.advisory, id: "CVE-2026-13221" },
          },
        }),
        analysisBytes,
      ),
    ).toThrow(/trusted checkout/);
    for (const name of [
      "../tools.json",
      "tools.json",
      "vulnerability-dispositions.json",
      "/etc/passwd",
    ])
      expect(() => readDispositionAnchor(name)).toThrow(/Unknown/);
  });
  it("uses a strict read boundary for real anchors and the larger occurrence ledger", () => {
    const directory = mkdtempSync(join(tmpdir(), "pdaa-perl-bound-")),
      file = join(directory, "bytes.json");
    try {
      for (const limit of [perlAnchorLimit, dispositionLedgerLimit]) {
        writeFileSync(file, Buffer.alloc(limit, 32));
        expect(readBoundedNodeFile(file, limit).length).toBe(limit);
        writeFileSync(file, Buffer.alloc(limit + 1, 32));
        expect(() => readBoundedNodeFile(file, limit)).toThrow();
      }
    } finally {
      unlinkSync(file);
      rmdirSync(directory);
    }
  });
  for (const target of realPolicy.targets)
    for (const scope of realPolicy.scopes)
      it(`preserves separate native occurrences in ${target}/${scope}`, () => {
        const f = fixture(target, scope),
          before = encode(f.scan);
        const rows = deriveReviewedPerlRows(f);
        expect(rows.map((r: any) => r.matchIndex)).toEqual([0, 2]);
        expect(rows.map((r: any) => r.matchSha256)).toEqual([
          hash(JSON.stringify(f.scan.matches[0])),
          hash(JSON.stringify(f.scan.matches[2])),
        ]);
        expect(
          rows.every(
            (r: any) =>
              r.advisoryId === "CVE-2026-8376" &&
              r.disposition === "not_applicable",
          ),
        ).toBe(true);
        expect(encode(f.scan)).toEqual(before);
        f.scan.matches = [];
        expect(deriveReviewedPerlRows(f)).toEqual([]);
      });
  it("production entrypoint refuses synthetic evidence even under real anchors", () => {
    const f = fixture();
    expect(() =>
      derivePerlDispositions({ ...f, policyBytes, analysisBytes }),
    ).toThrow(/coverage|evidence/);
    f.target = "web";
    expect(
      derivePerlDispositions({ ...f, policyBytes, analysisBytes }),
    ).toEqual([]);
  });
  const mutations: [string, (f: any) => void][] = [
    ["package version", (f) => (f.sbom.artifacts[0].version = "changed")],
    [
      "package architecture",
      (f) => (f.sbom.artifacts[0].metadata.architecture = "i386"),
    ],
    [
      "unknown package metadata",
      (f) => (f.sbom.artifacts[0].metadata.extra = true),
    ],
    ["missing ownership", (f) => f.sbom.artifacts[0].metadata.files.pop()],
    [
      "duplicate ownership",
      (f) =>
        f.sbom.artifacts[0].metadata.files.push(
          f.sbom.artifacts[0].metadata.files[0],
        ),
    ],
    ["missing package", (f) => (f.sbom.artifacts = [])],
    [
      "unknown Perl source package",
      (f) =>
        f.sbom.artifacts.push({
          ...structuredClone(f.sbom.artifacts[0]),
          id: "new",
          name: "perl-unreviewed",
        }),
    ],
    [
      "changed package location",
      (f) =>
        (f.sbom.artifacts[0].locations[0].layerID =
          f.inspection.RootFS.Layers[1]),
    ],
    ["missing material", (f) => f.sbom.files.shift()],
    [
      "changed bytes",
      (f) => (f.sbom.files[0].digests[0].value = hash("changed")),
    ],
    ["changed size", (f) => f.sbom.files[0].metadata.size++],
    ["changed file mode", (f) => (f.sbom.files[0].metadata.mode = 777)],
    [
      "changed configuration bytes",
      (f) =>
        (f.sbom.files.find((x: any) =>
          x.location.path.endsWith("Config_heavy.pl"),
        ).digests[0].value = hash("ptrsize=4")),
    ],
    [
      "duplicate physical ID",
      (f) => f.sbom.files.push(structuredClone(f.sbom.files[0])),
    ],
    [
      "duplicate same-path physical copy",
      (f) =>
        f.sbom.files.push({
          ...structuredClone(f.sbom.files[0]),
          id: "duplicate",
        }),
    ],
    [
      "extra lower-layer copy",
      (f) =>
        f.sbom.files.push({
          ...structuredClone(f.sbom.files[0]),
          id: "lower",
          location: {
            ...f.sbom.files[0].location,
            layerID: f.inspection.RootFS.Layers[1],
          },
        }),
    ],
    [
      "unknown supplying layer",
      (f) => (f.sbom.files[0].location.layerID = "unknown"),
    ],
    [
      "changed supplying ordinal",
      (f) => (f.sbom.files[0].location.layerID = f.inspection.RootFS.Layers[1]),
    ],
    ["missing relation", (f) => f.sbom.artifactRelationships.shift()],
    [
      "duplicate relation",
      (f) =>
        f.sbom.artifactRelationships.push(
          structuredClone(f.sbom.artifactRelationships[0]),
        ),
    ],
    [
      "unknown endpoint",
      (f) =>
        f.sbom.artifactRelationships.push({
          parent: "perl-base",
          child: "unknown",
          type: "evident-by",
        }),
    ],
    [
      "renamed byte-identical copy",
      (f) =>
        f.sbom.files.push({
          ...structuredClone(f.sbom.files[0]),
          id: "renamed",
          location: {
            path: "/opt/renamed",
            layerID: f.inspection.RootFS.Layers[0],
          },
        }),
    ],
    [
      "new libperl consumer",
      (f) =>
        f.sbom.files.push({
          id: "consumer",
          location: {
            path: "/opt/other",
            layerID: f.inspection.RootFS.Layers[0],
          },
          metadata: { type: "RegularFile" },
          executable: { importedLibraries: ["libperl.so.5.36"] },
        }),
    ],
    [
      "new named interpreter",
      (f) =>
        f.sbom.files.push({
          id: "other",
          location: {
            path: "/opt/perl",
            layerID: f.inspection.RootFS.Layers[0],
          },
          metadata: { type: "RegularFile" },
        }),
    ],
    [
      "changed native executable imports",
      (f) => f.sbom.files[0].executable.importedLibraries.push("libperl32.so"),
    ],
    [
      "advisory description",
      (f) =>
        (f.scan.matches[0].vulnerability.description = "all architectures"),
    ],
    [
      "advisory fix",
      (f) =>
        (f.scan.matches[0].vulnerability.fix = {
          state: "fixed",
          versions: ["new"],
        }),
    ],
    [
      "scan metadata",
      (f) => (f.scan.matches[0].artifact.metadata.changed = true),
    ],
    [
      "match lookup details",
      (f) => (f.scan.matches[0].matchDetails[0].matcher = "different"),
    ],
    [
      "related advisory",
      (f) => (f.scan.matches[0].relatedVulnerabilities = [{ id: "different" }]),
    ],
    ["scan location", (f) => (f.scan.matches[0].artifact.locations = [])],
    [
      "wrong scope",
      (f) => (f.sbom.descriptor.configuration.search.scope = "all-layers"),
    ],
    ["wrong target", (f) => (f.target = "database")],
  ];
  for (const [name, mutate] of mutations)
    it(`rejects ${name}`, () => {
      const f = fixture();
      mutate(f);
      expect(() => deriveReviewedPerlRows(f)).toThrow();
    });
  it("binds identity references anew when fresh file/package IDs and layer digests change", () => {
    const f = fixture(),
      original = deriveReviewedPerlRows(f);
    const replacement = "sha256:" + hash("fresh equivalent base");
    const old = f.inspection.RootFS.Layers[0];
    const replace = (value: any): any =>
      Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, replace(v)]),
            )
          : value === old
            ? replacement
            : value;
    const fresh = replace(f);
    fresh.inspection.Id = "sha256:" + hash("fresh image");
    fresh.sbom.source.metadata.imageID = fresh.inspection.Id;
    fresh.sbom.artifacts[0].id = "fresh-package";
    for (const m of fresh.scan.matches) m.artifact.id = "fresh-package";
    for (const r of fresh.sbom.artifactRelationships)
      r.parent = "fresh-package";
    const rows = deriveReviewedPerlRows(fresh);
    expect(rows).toHaveLength(2);
    expect(rows[0].scopeFactsSha256).toBe(original[0].scopeFactsSha256);
    expect(rows[0].matchSha256).not.toBe(original[0].matchSha256);
    expect(rows[0].imageId).toBe(fresh.inspection.Id);
    // Stable identities never authorize a changed byte or supplying layer.
    fresh.sbom.files[0].digests[0].value = hash("changed");
    expect(() => deriveReviewedPerlRows(fresh)).toThrow();
  });
  it("leaves unknown advisories and namespaces open", () => {
    const f = fixture();
    f.scan.matches[0].vulnerability.namespace = "different";
    f.scan.matches[2].vulnerability.id = "CVE-2026-13221";
    expect(deriveReviewedPerlRows(f)).toEqual([]);
  });
});
describe("combined occurrence ledger", () => {
  const report = { runId: "run", sourceTree: "tree" };
  const source = (rows: any[]) => ({
    ...report,
    schemaVersion: 1,
    inputs: [],
    dispositions: rows,
    releaseApproved: false,
    originalFindingsUnchanged: true,
  });
  const row = {
    target: "database",
    scope: "squashed",
    matchIndex: 2,
    disposition: "not_applicable",
  };
  it("preserves existing rows and separate proof sources without duplication", () => {
    const gosu = source([{ ...row, ruleId: "gosu" }]),
      perl = source([{ ...row, ruleId: "perl", matchIndex: 3 }]);
    const before = encode({ gosu, perl }),
      result = composeDispositionReports(report, { gosu, perl });
    expect(result.schemaVersion).toBe(3);
    expect(result.dispositions).toEqual([
      ...gosu.dispositions,
      ...perl.dispositions,
    ]);
    expect(result.proofs.gosu.dispositions).toBeUndefined();
    expect(result.releaseApproved).toBe(false);
    expect(encode({ gosu, perl })).toEqual(before);
  });
  it("rejects occurrence collisions, missing sources, mismatched runs and unsupported approval", () => {
    expect(() =>
      composeDispositionReports(report, {
        gosu: source([row]),
        perl: source([row]),
      }),
    ).toThrow(/collision/);
    expect(() =>
      composeDispositionReports(report, { gosu: source([]) }),
    ).toThrow();
    expect(() =>
      composeDispositionReports(report, {
        gosu: source([]),
        perl: { ...source([]), runId: "old" },
      }),
    ).toThrow(/run/);
    expect(() =>
      composeDispositionReports(report, {
        gosu: source([]),
        perl: { ...source([]), sourceTree: "old" },
      }),
    ).toThrow(/tree/);
    expect(() =>
      composeDispositionReports(report, {
        gosu: source([]),
        perl: { ...source([]), releaseApproved: true },
      }),
    ).toThrow();
  });
});

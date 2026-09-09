import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveGosuDispositions,
  validateGosuAnchors,
  buildGosuDispositionReport,
  verifyGosuDispositionReport,
} from "../scripts/distribution/gosu-dispositions.mjs";
import {
  hash,
  validateImageReports,
  assertReleaseReady,
} from "../scripts/distribution/evidence.mjs";

const policyBytes = readFileSync(
  "scripts/distribution/gosu-disposition-policy.json",
);
const analysisBytes = readFileSync(
  "scripts/distribution/gosu-static-analysis.json",
);
const policy = JSON.parse(policyBytes.toString());
const encode = (v: any) => Buffer.from(JSON.stringify(v));
const pins = JSON.parse(
  readFileSync("scripts/distribution/tools.json", "utf8"),
);
function fixture(target = "database", scope = "squashed"): any {
  const id = "sha256:" + hash(target),
    layerID = "sha256:" + hash("gosu layer");
  const config = encode({
    os: "linux",
    architecture: "amd64",
    rootfs: { diff_ids: [layerID] },
  });
  const imageID = "sha256:" + hash(config);
  const locations = [
    {
      path: policy.binary.path,
      accessPath: policy.binary.path,
      layerID,
      annotations: { evidence: "primary" },
    },
  ];
  const standard = {
    id: "stdlib",
    name: "stdlib",
    version: "go1.24.6",
    type: "go-module",
    language: "go",
    purl: "pkg:golang/stdlib@1.24.6",
    foundBy: "go-module-binary-cataloger",
    metadataType: "go-module-buildinfo-entry",
    licenses: [],
    metadata: { goCompiledVersion: "go1.24.6" },
    locations,
  };
  const main = {
    ...standard,
    id: "gosu",
    name: policy.binary.mainModule,
    purl: "pkg:golang/github.com/tianon/gosu@v1.19.0",
    version: policy.binary.moduleVersion,
  };
  const os = {
    id: "os",
    name: "os",
    version: "1",
    type: "deb",
    licenses: [],
    locations: [{ path: "/var/lib/dpkg/status", layerID }],
  };
  const sbom = {
    descriptor: {
      name: "syft",
      version: pins.syft.version,
      configuration: { search: { scope } },
    },
    source: {
      type: "image",
      metadata: {
        userInput: id,
        imageID,
        config: config.toString("base64"),
        manifestDigest: id,
      },
    },
    artifacts: [standard, main, os],
    artifactRelationships: [
      {
        parent: "stdlib",
        child: "file",
        type: "evident-by",
        metadata: { kind: "primary" },
      },
      {
        parent: "gosu",
        child: "file",
        type: "evident-by",
        metadata: { kind: "primary" },
      },
      { parent: "stdlib", child: "gosu", type: "dependency-of" },
    ],
    files: [
      {
        id: "file",
        location: { path: policy.binary.path, layerID },
        metadata: { type: "RegularFile", size: policy.binary.size },
        digests: [{ algorithm: "sha256", value: policy.binary.sha256 }],
      },
      {
        id: "notice",
        location: { path: "/usr/share/doc/os/copyright", layerID },
        contents: Buffer.from("Original notice").toString("base64"),
      },
    ],
  };
  return {
    target,
    scope,
    policyBytes,
    analysisBytes,
    pins,
    inspection: {
      Id: id,
      Os: "linux",
      Architecture: "amd64",
      RootFS: { Layers: [layerID] },
    },
    sbom,
    spdx: {
      spdxVersion: "SPDX-2.3",
      packages: sbom.artifacts.map((p) => ({
        name: p.name,
        versionInfo: p.version,
      })),
    },
    scan: {
      descriptor: {
        name: "grype",
        version: pins.grype.version,
        db: {
          status: {
            valid: true,
            built: new Date().toISOString(),
            from:
              "https://grype.anchore.io/databases/db.tar.zst?checksum=sha256%3A" +
              "c".repeat(64),
          },
        },
        configuration: {
          search: { scope },
          "only-fixed": false,
          "only-notfixed": false,
          "ignore-wontfix": "",
          exclude: [],
          "vex-documents": [],
          "vex-add": [],
          ignore: [],
          "match-upstream-kernel-headers": true,
          db: {
            "validate-age": true,
            "validate-by-hash-on-start": true,
            "require-update-check": true,
          },
        },
      },
      source: { type: "image", target: { imageID, manifestDigest: id } },
      ignoredMatches: [],
      matches: [
        {
          artifact: structuredClone(standard),
          vulnerability: {
            ...structuredClone(policy.rules[0].advisory),
            severity: "Critical",
          },
        },
        {
          artifact: structuredClone(standard),
          vulnerability: {
            id: "GO-OTHER",
            namespace: "govulndb:language:go",
            severity: "High",
          },
        },
      ],
    },
  };
}

describe("exact gosu occurrence dispositions (NFR-SEC-010 / AC-MNT-004)", () => {
  it("binds every approved advisory separately and leaves Root and unknown matches open", () => {
    const f = fixture(),
      original = structuredClone(f.scan.matches[0]);
    f.scan.matches = policy.rules.map((r: any) => ({
      ...structuredClone(original),
      vulnerability: { ...structuredClone(r.advisory), severity: "High" },
    }));
    f.scan.matches.push({
      ...structuredClone(original),
      vulnerability: {
        id: "GO-2026-4970",
        namespace: "govulndb:language:go",
        severity: "High",
      },
    });
    f.scan.matches.push(structuredClone(f.scan.matches[0]));
    const before = encode(f.scan),
      rows = deriveGosuDispositions(f);
    expect(rows).toHaveLength(24);
    expect(rows.slice(0, 23).map((r: any) => r.advisoryId)).toEqual(
      policy.rules.map((r: any) => r.advisory.id),
    );
    expect(rows.map((r: any) => r.matchIndex)).toEqual([
      ...Array(23).keys(),
      24,
    ]);
    expect(
      rows.every(
        (r: any) =>
          r.matchSha256 === hash(JSON.stringify(f.scan.matches[r.matchIndex])),
      ),
    ).toBe(true);
    expect(encode(f.scan)).toEqual(before);
    expect(
      validateImageReports(f).findings.every(
        (r: any) => r.disposition === "unreviewed",
      ),
    ).toBe(true);
  });
  it("rejects cross-advisory semantics even when both IDs have approved rules", () => {
    const f = fixture();
    f.scan.matches[0].vulnerability.id = policy.rules[1].advisory.id;
    expect(() => deriveGosuDispositions(f)).toThrow(/advisory semantics/);
  });
  for (const [name, mutate] of [
    [
      "missing second-module import",
      (p: any, _a: any) => {
        p.rules.find(
          (r: any) => r.advisory.id === "GO-2026-4918",
        ).requiredPackages = ["net/http"];
      },
    ],
    [
      "missing third affected import",
      (p: any, _a: any) => {
        p.rules.find(
          (r: any) => r.advisory.id === "GO-2026-5026",
        ).requiredPackages = ["net/http", "net/http/internal/http2"];
      },
    ],
    [
      "duplicate rule",
      (p: any, _a: any) => {
        p.rules[1] = structuredClone(p.rules[0]);
      },
    ],
    [
      "Root rule substitution",
      (p: any, _a: any) => {
        p.rules[1].advisory.id = "GO-2026-4970";
      },
    ],
    [
      "missing package metadata",
      (_p: any, a: any) => {
        a.packages = a.packages.filter((p: any) => p.path !== "net/mail");
      },
    ],
    [
      "ambiguous package metadata",
      (_p: any, a: any) => {
        a.packages.push(a.packages[0]);
      },
    ],
    [
      "present inline function",
      (_p: any, a: any) => {
        a.packages.find((p: any) => p.path === "net/mail").names = [
          "net/mail.ParseAddress",
        ];
      },
    ],
    [
      "present emitted function",
      (_p: any, a: any) => {
        a.packages.find((p: any) => p.path === "crypto/x509").functions = [
          "crypto/x509.ParseCertificate",
        ];
      },
    ],
    [
      "present trimpath source file",
      (_p: any, a: any) => {
        a.packages.find((p: any) => p.path === "encoding/xml").files = [
          "encoding/xml/read.go",
        ];
      },
    ],
    [
      "missing present-package control",
      (_p: any, a: any) => {
        a.packages.find((p: any) => p.path === "os").files = [];
      },
    ],
  ] as [string, (p: any, a: any) => void][])
    it(`rejects ${name} even with matching supplied trust fixtures`, () => {
      const p = structuredClone(policy),
        a = JSON.parse(analysisBytes.toString());
      mutate(p, a);
      // Exercise structural proof checks independently of archive trust rejection.
      expect(() =>
        validateGosuAnchors(encode(p), encode(a), {
          trustedPolicyBytes: encode(p),
          trustedAnalysisBytes: encode(a),
        }),
      ).toThrow();
    });
  for (const target of ["database", "operations"])
    for (const scope of ["squashed", "all-layers"])
      it(`binds ${target}/${scope} without changing original findings`, () => {
        const f = fixture(target, scope),
          before = encode(f.scan);
        const original = validateImageReports(f);
        const rows = deriveGosuDispositions(f);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          target,
          scope,
          matchIndex: 0,
          disposition: "not_applicable",
          imageId: f.inspection.Id,
          fileId: "file",
          packageId: "stdlib",
          matchSha256: hash(JSON.stringify(f.scan.matches[0])),
        });
        expect(original.findings.map((v: any) => v.disposition)).toEqual([
          "unreviewed",
          "unreviewed",
        ]);
        expect(encode(f.scan)).toEqual(before);
      });
  it("preserves duplicate match occurrences with distinct indices", () => {
    const f = fixture();
    f.scan.matches.push(structuredClone(f.scan.matches[0]));
    expect(deriveGosuDispositions(f).map((r: any) => r.matchIndex)).toEqual([
      0, 2,
    ]);
  });
  it("does not cover absent matches, foreign namespaces, targets or other binaries", () => {
    for (const mutate of [
      (f: any) => {
        f.scan.matches = [];
      },
      (f: any) => {
        f.scan.matches[0].vulnerability.namespace = "nvd:cpe";
      },
      (f: any) => {
        f.target = "web";
      },
      (f: any) => {
        f.scan.matches[0].artifact.locations[0].path = "/other";
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(deriveGosuDispositions(f)).toEqual([]);
    }
  });
  const mutations: [string, (f: any) => void][] = [
    [
      "main module type",
      (f) => {
        f.sbom.artifacts[1].type = "npm";
      },
    ],
    [
      "main module purl",
      (f) => {
        f.sbom.artifacts[1].purl = "pkg:golang/other@v1.19.0";
      },
    ],
    [
      "main module cataloger",
      (f) => {
        f.sbom.artifacts[1].foundBy = "other";
      },
    ],
    [
      "missing primary relationship",
      (f) => {
        f.sbom.artifactRelationships.shift();
      },
    ],
    [
      "redirected primary relationship",
      (f) => {
        f.sbom.artifactRelationships[0].child = "notice";
      },
    ],
    [
      "secondary evidence",
      (f) => {
        f.sbom.artifactRelationships[0].metadata.kind = "secondary";
      },
    ],
    [
      "duplicate primary relationship",
      (f) => {
        f.sbom.artifactRelationships.push(f.sbom.artifactRelationships[0]);
      },
    ],
    [
      "redirected dependency",
      (f) => {
        f.sbom.artifactRelationships[2].child = "another";
      },
    ],
    [
      "advisory description",
      (f) => {
        f.scan.matches[0].vulnerability.description += " changed";
      },
    ],
    [
      "advisory fixes",
      (f) => {
        f.scan.matches[0].vulnerability.fix.versions = [];
      },
    ],
    [
      "package version",
      (f) => {
        f.sbom.artifacts[0].version = "go1.24.7";
      },
    ],
    [
      "scan package",
      (f) => {
        f.scan.matches[0].artifact.purl = "pkg:golang/stdlib@1.24.7";
      },
    ],
    [
      "package duplicate",
      (f) => {
        f.sbom.artifacts.push(structuredClone(f.sbom.artifacts[0]));
      },
    ],
    [
      "file duplicate",
      (f) => {
        f.sbom.files.push(structuredClone(f.sbom.files[0]));
      },
    ],
    [
      "file ID collision",
      (f) => {
        f.sbom.files[1].id = "file";
      },
    ],
    [
      "missing file",
      (f) => {
        f.sbom.files.shift();
      },
    ],
    [
      "file size",
      (f) => {
        f.sbom.files[0].metadata.size++;
      },
    ],
    [
      "file digest",
      (f) => {
        f.sbom.files[0].digests[0].value = "a".repeat(64);
      },
    ],
    [
      "digest duplicate",
      (f) => {
        f.sbom.files[0].digests.push(f.sbom.files[0].digests[0]);
      },
    ],
    [
      "file layer",
      (f) => {
        f.sbom.files[0].location.layerID = "sha256:" + "e".repeat(64);
      },
    ],
    [
      "unknown layer",
      (f) => {
        f.inspection.RootFS.Layers = [];
      },
    ],
    [
      "main module",
      (f) => {
        f.sbom.artifacts[1].name = "another-module";
      },
    ],
    [
      "main module version",
      (f) => {
        f.sbom.artifacts[1].version = "v2.0.0";
      },
    ],
    [
      "compiler",
      (f) => {
        f.sbom.artifacts[0].metadata.goCompiledVersion = "go1.26.8";
      },
    ],
    [
      "scope",
      (f) => {
        f.sbom.descriptor.configuration.search.scope = "unknown";
      },
    ],
    [
      "policy forgery",
      (f) => {
        const p = JSON.parse(policyBytes.toString());
        p.disposition = "approved";
        f.policyBytes = encode(p);
      },
    ],
    [
      "incomplete extraction",
      (f) => {
        const a = JSON.parse(analysisBytes.toString());
        a.functions--;
        f.analysisBytes = encode(a);
      },
    ],
    [
      "module-only fallback",
      (f) => {
        const a = JSON.parse(analysisBytes.toString());
        a.method = "module-only";
        f.analysisBytes = encode(a);
      },
    ],
    [
      "TLS code present",
      (f) => {
        const a = JSON.parse(analysisBytes.toString());
        a.cryptoTlsNames = ["crypto/tls.Dial"];
        f.analysisBytes = encode(a);
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    it(`rejects ${name}`, () => {
      const f = fixture();
      mutate(f);
      expect(() => deriveGosuDispositions(f)).toThrow();
    });
  it("rejects duplicate JSON keys but permits syntax whitespace", () => {
    expect(() =>
      validateGosuAnchors(
        Buffer.from(
          policyBytes
            .toString()
            .replace(
              '"schemaVersion": 2',
              '"schemaVersion": 2, "schemaVersion": 2',
            ),
        ),
        analysisBytes,
      ),
    ).toThrow();
    expect(() =>
      validateGosuAnchors(
        encode(policy),
        encode(JSON.parse(analysisBytes.toString())),
      ),
    ).not.toThrow();
  });
});

function archive(
  check: (
    directory: string,
    report: any,
    rewrite: (name: string, v: any) => void,
  ) => void,
  allRules = false,
) {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-gosu-"));
  const report: any = {
    runId: "pdaa-distribution-1-abcdef12",
    sourceTree: "a".repeat(40),
    status: "complete",
    images: {},
    tools: pins,
    distributionAccepted: false,
    blockers: [{ code: "vulnerability-dispositions" }],
  };
  const rewrite = (name: string, v: any) =>
    writeFileSync(join(directory, name), Buffer.isBuffer(v) ? v : encode(v));
  try {
    rewrite("gosu-disposition-policy.json", policyBytes);
    rewrite("gosu-static-analysis.json", analysisBytes);
    for (const target of ["api", "worker", "web", "database", "operations"]) {
      const f = fixture(target);
      report.images[target] = { imageId: f.inspection.Id };
      if (!["database", "operations"].includes(target)) continue;
      rewrite(`${target}.image.json`, f.inspection);
      for (const [suffix, scope] of [
        ["", "squashed"],
        [".layers", "all-layers"],
      ]) {
        const scoped = fixture(target, scope);
        if (allRules) {
          const original = scoped.scan.matches[0];
          scoped.scan.matches = policy.rules.map((r: any) => ({
            ...structuredClone(original),
            vulnerability: { ...structuredClone(r.advisory), severity: "High" },
          }));
        }
        const review = validateImageReports(scoped);
        if (suffix) report.images[target].allLayers = review;
        else report.images[target] = review;
        for (const ext of ["syft", "spdx", "grype"])
          rewrite(
            `${target}${suffix}.${ext}.json`,
            scoped[ext === "syft" ? "sbom" : ext === "grype" ? "scan" : "spdx"],
          );
      }
    }
    const ledger = buildGosuDispositionReport(directory, report);
    rewrite("vulnerability-dispositions.json", ledger);
    report.vulnerabilityDispositions = {
      file: "vulnerability-dispositions.json",
      notApplicable: ledger.dispositions.length,
      releaseApproved: false,
    };
    check(directory, report, rewrite);
  } finally {
    for (const name of readdirSync(directory))
      unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
}
describe("retained disposition replay", () => {
  it("replays a complete 92-occurrence ledger beyond the prior 64 KiB limit", () =>
    archive((directory, report, rewrite) => {
      const bytes = readFileSync(
        join(directory, "vulnerability-dispositions.json"),
      );
      expect(bytes.length).toBeGreaterThan(64 * 1024);
      const result = verifyGosuDispositionReport(directory, report);
      expect(result.schemaVersion).toBe(2);
      expect(result.dispositions).toHaveLength(92);
      expect(
        new Set(result.dispositions.map((r: any) => r.advisoryId)).size,
      ).toBe(23);
      const forged = structuredClone(result);
      forged.dispositions[1].ruleId = forged.dispositions[0].ruleId;
      rewrite("vulnerability-dispositions.json", forged);
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow(
        /dispositions differ/,
      );
      rewrite(
        "vulnerability-dispositions.json",
        Buffer.alloc(512 * 1024 + 1, 32),
      );
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow();
    }, true));
  it("rejects coherently replaced scanner versions and declared pins", () =>
    archive((directory, report, rewrite) => {
      report.tools = structuredClone(report.tools);
      report.tools.grype.version = "unapproved";
      for (const target of ["database", "operations"])
        for (const suffix of ["", ".layers"]) {
          const name = `${target}${suffix}.grype.json`;
          const scan = JSON.parse(readFileSync(join(directory, name), "utf8"));
          scan.descriptor.version = "unapproved";
          rewrite(name, scan);
        }
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow(
        /Scanner pins/,
      );
    }));
  it("rejects forged original severity counts", () =>
    archive((directory, report) => {
      report.images.database.severityCounts.Critical = 0;
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow(
        /severity counts/,
      );
    }));
  it("reconstructs all four inputs and occurrences while preserving the release block", () =>
    archive((directory, report) => {
      const result = verifyGosuDispositionReport(directory, report);
      expect(result.dispositions).toHaveLength(4);
      expect(result.inputs).toHaveLength(4);
      expect(() =>
        assertReleaseReady({
          ...report,
          blockers: [],
          distributionAccepted: true,
        }),
      ).toThrow();
    }));
  it("rejects coherently rehashed policy and receipt forgeries", () =>
    archive((directory, report, rewrite) => {
      const a = JSON.parse(analysisBytes.toString());
      a.functionNames = 1;
      rewrite("gosu-static-analysis.json", a);
      const ledger = JSON.parse(
        readFileSync(
          join(directory, "vulnerability-dispositions.json"),
          "utf8",
        ),
      );
      ledger.analysisSha256 = hash(encode(a));
      rewrite("vulnerability-dispositions.json", ledger);
      report.files = { "gosu-static-analysis.json": hash(encode(a)) };
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow(
        /trusted checkout/,
      );
    }));
  for (const field of [
    "matchIndex",
    "imageId",
    "fileId",
    "matchSha256",
    "disposition",
  ])
    it(`rejects retained ${field} substitution`, () =>
      archive((directory, report, rewrite) => {
        const ledger = JSON.parse(
          readFileSync(
            join(directory, "vulnerability-dispositions.json"),
            "utf8",
          ),
        );
        ledger.dispositions[0][field] = "forged";
        rewrite("vulnerability-dispositions.json", ledger);
        expect(() => verifyGosuDispositionReport(directory, report)).toThrow(
          /dispositions differ/,
        );
      }));
  it("rejects stale scans, substituted accepted image and missing analysis", () =>
    archive((directory, report, rewrite) => {
      const name = "database.grype.json",
        scan = JSON.parse(readFileSync(join(directory, name), "utf8"));
      scan.descriptor.db.status.built = "2000-01-01T00:00:00Z";
      rewrite(name, scan);
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow(
        /stale/,
      );
      scan.descriptor.db.status.built = new Date().toISOString();
      rewrite(name, scan);
      report.images.database.imageId = "wrong";
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow();
      unlinkSync(join(directory, "gosu-static-analysis.json"));
      expect(() => verifyGosuDispositionReport(directory, report)).toThrow();
    }));
});

import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hash,
  validateImageReports,
  requireCompleteTargets,
  assertReleaseReady,
  reconcileApplicationPackages,
  verifyEvidenceFiles,
} from "../scripts/distribution/evidence.mjs";
import {
  validateBrowserInventory,
  validateBrowserSpdx,
} from "../scripts/distribution/browser.mjs";

const pins = { syft: { version: "1.51.1" }, grype: { version: "0.118.0" } };
const now = Date.parse("2026-09-06T12:00:00Z");
function fixture() {
  const id = "sha256:" + "a".repeat(64);
  const layers = ["sha256:" + "b".repeat(64)];
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    rootfs: { diff_ids: layers },
  });
  const imageID = "sha256:" + hash(config);
  return {
    pins,
    now,
    inspection: {
      Id: id,
      Os: "linux",
      Architecture: "amd64",
      RootFS: { Layers: layers },
    },
    sbom: {
      descriptor: { name: "syft", version: pins.syft.version },
      source: {
        type: "image",
        metadata: {
          userInput: id,
          imageID,
          config: Buffer.from(config).toString("base64"),
          manifestDigest: id,
        },
      },
      artifacts: [
        {
          id: "deb1",
          name: "fixture-os",
          version: "1",
          type: "deb",
          licenses: [{ spdxExpression: "GPL-2.0-only" }],
        },
      ],
      files: [
        {
          location: { path: "/usr/share/doc/fixture-os/copyright" },
          contents: Buffer.from("Original fixture license").toString("base64"),
        },
      ],
    },
    spdx: {
      spdxVersion: "SPDX-2.3",
      packages: [{ name: "fixture-os", versionInfo: "1" }],
    },
    scan: {
      descriptor: {
        name: "grype",
        version: pins.grype.version,
        db: {
          status: {
            valid: true,
            built: "2026-09-06T06:00:00Z",
            from:
              "https://grype.anchore.io/databases/db.tar.zst?checksum=sha256%3A" +
              "c".repeat(64),
          },
        },
        configuration: {
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
      matches: [
        {
          artifact: { id: "deb1", name: "fixture-os", version: "1" },
          vulnerability: {
            id: "CVE-FIXTURE-1",
            severity: "High",
            namespace: "fixture",
            dataSource: "https://example.test/advisory",
            fix: { state: "not-fixed", versions: [] },
          },
        },
      ],
      ignoredMatches: [],
    },
  };
}

describe("immutable distribution evidence", () => {
  it("counts original notices separately from captured inventory metadata", () => {
    const f = fixture();
    for (const path of [
      "/app/runtime-inventory.json",
      "/srv/third-party-components.json",
    ])
      f.sbom.files.push({
        location: { path },
        contents: Buffer.from("{}").toString("base64"),
      });
    expect(validateImageReports(f).notices).toHaveLength(1);
    f.sbom.files.shift();
    expect(() => validateImageReports(f)).toThrow(/notice file capture/);
    f.sbom.files.push({
      location: { path: "/srv/THIRD_PARTY_NOTICES.txt" },
      contents: Buffer.from("Original notices").toString("base64"),
    });
    expect(validateImageReports(f).notices).toHaveLength(1);
  });
  it("retains copyleft and unfixed high findings as review work", () => {
    const report = validateImageReports(fixture());
    expect(report.licenseReview[0].licenses).toEqual(["GPL-2.0-only"]);
    expect(report.findings[0]).toMatchObject({
      severity: "High",
      disposition: "unreviewed",
      fix: { state: "not-fixed" },
    });
    expect(report.notices[0].sha256).toBe(hash("Original fixture license"));
  });
  it.each([
    [
      "substituted source",
      (f: ReturnType<typeof fixture>) => {
        f.sbom.source.metadata.userInput = "other";
      },
    ],
    [
      "different filesystem",
      (f: ReturnType<typeof fixture>) => {
        f.inspection.RootFS.Layers = ["sha256:" + "d".repeat(64)];
      },
    ],
    [
      "changed config bytes",
      (f: ReturnType<typeof fixture>) => {
        f.sbom.source.metadata.config = Buffer.from("{}").toString("base64");
      },
    ],
    [
      "empty OS inventory",
      (f: ReturnType<typeof fixture>) => {
        f.sbom.artifacts = [];
      },
    ],
    [
      "substituted SPDX package",
      (f: ReturnType<typeof fixture>) => {
        f.spdx.packages[0]!.versionInfo = "2";
      },
    ],
    [
      "substituted scan",
      (f: ReturnType<typeof fixture>) => {
        f.scan.source.target.imageID = "other";
      },
    ],
    [
      "unpinned scanner",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.version = "0.1";
      },
    ],
    [
      "stale database",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.db.status.built = "2026-08-01T00:00:00Z";
      },
    ],
    [
      "future database",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.db.status.built = "2026-09-07T00:00:00Z";
      },
    ],
    [
      "invalid database",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.db.status.valid = false;
      },
    ],
    [
      "database checksum unchecked",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.configuration.db["validate-by-hash-on-start"] = false;
      },
    ],
    [
      "unfixed findings hidden",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.configuration["only-fixed"] = true;
      },
    ],
    [
      "implicit suppression",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.configuration["match-upstream-kernel-headers"] =
          false;
      },
    ],
    [
      "missing original notice capture",
      (f: ReturnType<typeof fixture>) => {
        f.sbom.files = [];
      },
    ],
    [
      "finding for an absent package",
      (f: ReturnType<typeof fixture>) => {
        f.scan.matches[0]!.artifact.id = "absent";
      },
    ],
  ])("rejects %s", (_name, change) => {
    const f = fixture();
    change(f);
    expect(() => validateImageReports(f)).toThrow();
  });
  it("rejects missing or reused customer image evidence and a forged release flag", () => {
    expect(() => requireCompleteTargets({ api: { imageId: "a" } })).toThrow();
    const images = Object.fromEntries(
      ["api", "worker", "web", "operations", "database"].map((key, i) => [
        key,
        { imageId: String(i) },
      ]),
    );
    expect(() => requireCompleteTargets(images)).not.toThrow();
    expect(() =>
      assertReleaseReady({
        status: "complete",
        images,
        distributionAccepted: true,
        blockers: [],
      }),
    ).toThrow(/signing/);
    images.database = images.api!;
    expect(() => requireCompleteTargets(images)).toThrow();
  });
});

function browserFixture() {
  const contents = Buffer.from("Original fixture notice").toString("base64");
  const inventory = {
    schemaVersion: 1,
    assets: [{ file: "assets/main.js", sha256: hash("code") }],
    components: [
      {
        name: "fixture",
        version: "1.0.0",
        license: "MIT",
        modules: ["index.js"],
        notices: [
          {
            path: "LICENSE",
            contents,
            sha256: hash("Original fixture notice"),
          },
        ],
      },
    ],
  };
  return {
    locked: new Map([["fixture@1.0.0", "sha512-fixture"]]),
    inventory,
    sbom: {
      files: [
        {
          location: { path: "/srv/third-party-components.json" },
          contents: Buffer.from(JSON.stringify(inventory)).toString("base64"),
        },
        { location: { path: "/srv/THIRD_PARTY_NOTICES.txt" }, contents },
        {
          location: { path: "/srv/assets/main.js" },
          digests: [{ algorithm: "sha256", value: hash("code") }],
        },
      ],
    },
  };
}
describe("browser bundle evidence", () => {
  it("rejects missing, substituted and non-SPDX browser conversion output", () => {
    const packages = [{ name: "fixture", version: "1.0.0" }];
    const spdx = {
      spdxVersion: "SPDX-2.3",
      packages: [{ name: "fixture", versionInfo: "1.0.0" }],
    };
    expect(() => validateBrowserSpdx(spdx, packages)).not.toThrow();
    expect(() =>
      validateBrowserSpdx({ ...spdx, packages: [] }, packages),
    ).toThrow(/coverage/);
    expect(() =>
      validateBrowserSpdx(
        { ...spdx, packages: [{ name: "other", versionInfo: "1.0.0" }] },
        packages,
      ),
    ).toThrow(/differs/);
    expect(() =>
      validateBrowserSpdx({ ...spdx, spdxVersion: "other" }, packages),
    ).toThrow(/conversion/);
  });
  it("binds module components, original notices and exact asset bytes", () => {
    const f = browserFixture();
    expect(
      validateBrowserInventory(f.sbom, f.locked).inventory.components,
    ).toHaveLength(1);
  });
  it("rejects changed assets, omitted scripts and unregistered components", () => {
    const f = browserFixture();
    f.sbom.files[2]!.digests![0]!.value = hash("changed");
    expect(() => validateBrowserInventory(f.sbom, f.locked)).toThrow(/asset/);
    const other = browserFixture();
    other.sbom.files.push({
      location: { path: "/srv/injected.js" },
      digests: [{ algorithm: "sha256", value: hash("injected") }],
    });
    expect(() => validateBrowserInventory(other.sbom, other.locked)).toThrow(
      /missing/,
    );
    const unknown = browserFixture();
    unknown.locked.clear();
    expect(() =>
      validateBrowserInventory(unknown.sbom, unknown.locked),
    ).toThrow(/lock/);
  });
  it("rejects substituted notices and absent browser metadata", () => {
    const f = browserFixture();
    f.inventory.components[0]!.notices[0]!.contents =
      Buffer.from("changed").toString("base64");
    f.sbom.files[0]!.contents = Buffer.from(
      JSON.stringify(f.inventory),
    ).toString("base64");
    expect(() => validateBrowserInventory(f.sbom, f.locked)).toThrow(
      /notice hash/,
    );
    expect(() => validateBrowserInventory({ files: [] }, f.locked)).toThrow(
      /missing/,
    );
  });
});

describe("application inventory reconciliation", () => {
  const parent = {
    id: "parent",
    name: "rxjs",
    version: "7.8.2",
    locations: [{ path: "/app/node_modules/rxjs/package.json" }],
  };
  const expected = { packages: [{ name: "rxjs", version: "7.8.2" }] };
  const locked = new Map([["rxjs@7.8.2", "sha512-fixture"]]);
  it("retains versionless embedded entry-point manifests with their locked parent", () => {
    const child = {
      id: "child",
      name: "rxjs/ajax",
      version: "UNKNOWN",
      locations: [{ path: "/app/node_modules/rxjs/ajax/package.json" }],
    };
    const result = reconcileApplicationPackages(
      [parent, child],
      expected,
      locked,
    );
    expect(result[1]).toMatchObject({
      embeddedManifestOf: "rxjs@7.8.2",
      reviewRequired: true,
    });
  });
  it("rejects omitted, unregistered and nested-node_modules packages", () => {
    expect(() => reconcileApplicationPackages([], expected, locked)).toThrow(
      /omitted/,
    );
    expect(() =>
      reconcileApplicationPackages([parent], expected, new Map()),
    ).toThrow(/lockfile/);
    const unknown = {
      id: "child",
      name: "other",
      version: "UNKNOWN",
      locations: [
        { path: "/app/node_modules/rxjs/node_modules/other/package.json" },
      ],
    };
    expect(() =>
      reconcileApplicationPackages([parent, unknown], expected, locked),
    ).toThrow(/parent/);
    const versioned = { ...unknown, version: "1.0.0" };
    expect(() =>
      reconcileApplicationPackages([parent, versioned], expected, locked),
    ).toThrow(/Unregistered/);
  });
});

it("rejects changed or missing files in a complete evidence bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-evidence-test-"));
  try {
    const images = Object.fromEntries(
      ["api", "worker", "web", "operations", "database"].map((key, i) => [
        key,
        { imageId: String(i) },
      ]),
    );
    const names = [
      "pnpm-lock.yaml",
      "lock-inventory.json",
      "production-acceptance.json",
      "browser.syft.json",
      "browser.spdx.json",
      "browser.grype.json",
      "browser.scan-receipt.json",
    ];
    for (const target of Object.keys(images))
      for (const suffix of [
        ".image.json",
        ".syft.json",
        ".spdx.json",
        ".grype.json",
        ".notices.json",
        ".review.json",
      ])
        names.push(target + suffix);
    for (const name of names) writeFileSync(join(directory, name), name);
    const report = {
      status: "complete",
      images,
      files: Object.fromEntries(names.map((n) => [n, hash(n)])),
    };
    expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
    writeFileSync(join(directory, "api.grype.json"), "changed");
    expect(() => verifyEvidenceFiles(directory, report)).toThrow(/changed/);
    writeFileSync(join(directory, "api.grype.json"), "api.grype.json");
    delete report.files["browser.scan-receipt.json"];
    expect(() => verifyEvidenceFiles(directory, report)).toThrow(
      /Required evidence/,
    );
  } finally {
    for (const name of readdirSync(directory))
      unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

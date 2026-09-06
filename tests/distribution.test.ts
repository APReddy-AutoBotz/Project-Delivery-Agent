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
  validateRuntimeTooling,
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
      descriptor: {
        name: "syft",
        version: pins.syft.version,
        configuration: { search: { scope: "squashed" } },
      },
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
          locations: [{ path: "/var/lib/dpkg/status", layerID: layers[0] }],
        },
      ],
      files: [
        {
          id: "notice1",
          location: {
            path: "/usr/share/doc/fixture-os/copyright",
            layerID: layers[0],
          },
          contents: Buffer.from("Original fixture license").toString("base64"),
        },
      ] as {
        id?: string;
        location: { path: string; layerID?: string };
        contents: string;
      }[],
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
          search: { scope: "squashed" },
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
      "incorrect Syft scope",
      (f: ReturnType<typeof fixture>) => {
        f.sbom.descriptor.configuration.search.scope = "all-layers";
      },
    ],
    [
      "incorrect Grype scope",
      (f: ReturnType<typeof fixture>) => {
        f.scan.descriptor.configuration.search.scope = "all-layers";
      },
    ],
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

describe("distributed layer evidence", () => {
  function layered() {
    const f = fixture();
    f.sbom.descriptor.configuration.search.scope = "all-layers";
    f.scan.descriptor.configuration.search.scope = "all-layers";
    return { ...f, scope: "all-layers" };
  }
  it("retains overwritten notices and finding package locations by layer", () => {
    const f = layered();
    const layer = "sha256:" + "d".repeat(64);
    f.inspection.RootFS.Layers.push(layer);
    const config = JSON.parse(
      Buffer.from(f.sbom.source.metadata.config, "base64").toString(),
    );
    config.rootfs.diff_ids = f.inspection.RootFS.Layers;
    const bytes = JSON.stringify(config);
    f.sbom.source.metadata.config = Buffer.from(bytes).toString("base64");
    f.sbom.source.metadata.imageID = "sha256:" + hash(bytes);
    f.scan.source.target.imageID = f.sbom.source.metadata.imageID;
    f.sbom.files.push({
      id: "notice2",
      location: { path: f.sbom.files[0]!.location.path, layerID: layer },
      contents: Buffer.from("Changed notice").toString("base64"),
    });
    const result = validateImageReports(f);
    expect(result.notices).toHaveLength(2);
    expect(result.notices.map((n: { fileId: string }) => n.fileId)).toEqual([
      "notice1",
      "notice2",
    ]);
    expect(result.notices[0].sha256).not.toBe(result.notices[1].sha256);
    expect(result.findings[0].locations).toEqual(
      f.sbom.artifacts[0]!.locations,
    );
  });
  it("rejects substituted scope and unbound historical file/package locations", () => {
    const f = layered();
    f.sbom.descriptor.configuration.search.scope = "squashed";
    expect(() => validateImageReports(f)).toThrow(/Syft scope/);
    f.sbom.descriptor.configuration.search.scope = "all-layers";
    f.scan.descriptor.configuration.search.scope = "squashed";
    expect(() => validateImageReports(f)).toThrow(/Grype scope/);
    f.scan.descriptor.configuration.search.scope = "all-layers";
    f.sbom.files[0]!.location.layerID = "unknown";
    expect(() => validateImageReports(f)).toThrow(/File layer/);
    f.sbom.files[0]!.location.layerID = f.inspection.RootFS.Layers[0];
    f.sbom.artifacts[0]!.locations[0]!.layerID = "unknown";
    expect(() => validateImageReports(f)).toThrow(/unknown layer/);
  });
});

describe("runtime tooling and Node attribution", () => {
  const policy = {
    nodeVersion: "24.19.0",
    nodeNoticeSha256: hash("Original Node notice"),
    nodeNoticePaths: {
      api: "/usr/local/LICENSE",
      worker: "/usr/local/LICENSE",
      operations: "/usr/local/share/doc/node/LICENSE",
    },
  };
  function runtime(path = "/usr/local/LICENSE") {
    return {
      artifacts: [{ name: "node", version: "24.19.0", type: "binary" }],
      files: [
        {
          location: { path },
          contents: Buffer.from("Original Node notice").toString("base64"),
        },
      ],
    };
  }
  it("rejects removed or empty protected-target policy and missing version/digest pins", () => {
    for (const target of ["api", "worker", "operations"] as const) {
      const paths: Record<string, string> = { ...policy.nodeNoticePaths };
      delete paths[target];
      expect(() =>
        validateRuntimeTooling(target, runtime(), {
          ...policy,
          nodeNoticePaths: paths,
        }),
      ).toThrow(/policy targets/);
      expect(() =>
        validateRuntimeTooling(target, runtime(), {
          ...policy,
          nodeNoticePaths: { ...policy.nodeNoticePaths, [target]: "" },
        }),
      ).toThrow(/notice path/);
    }
    expect(() =>
      validateRuntimeTooling("api", runtime(), { ...policy, nodeVersion: "" }),
    ).toThrow(/version missing/);
    expect(() =>
      validateRuntimeTooling("api", runtime(), {
        ...policy,
        nodeNoticeSha256: "",
      }),
    ).toThrow(/digest missing/);
  });
  it("preserves the original notice for both runtime and copied operations Node", () => {
    expect(() =>
      validateRuntimeTooling("api", runtime(), policy),
    ).not.toThrow();
    expect(() =>
      validateRuntimeTooling(
        "operations",
        runtime(policy.nodeNoticePaths.operations),
        policy,
      ),
    ).not.toThrow();
    const wrong = runtime();
    wrong.files[0]!.contents = Buffer.from("Changed notice").toString("base64");
    expect(() => validateRuntimeTooling("worker", wrong, policy)).toThrow(
      /notice differs/,
    );
    expect(() =>
      validateRuntimeTooling("operations", runtime(), policy),
    ).toThrow(/notice missing/);
    const changed = runtime();
    changed.artifacts[0]!.version = "24.0.0";
    expect(() => validateRuntimeTooling("api", changed, policy)).toThrow(
      /Node binary/,
    );
  });
  it.each([
    "/usr/local/lib/node_modules/npm/node_modules/tar/package.json",
    "/usr/local/lib/node_modules/corepack/dist/corepack.js",
    "/opt/yarn-v1.22.22/lib/cli.js",
    "/usr/local/bin/npm",
    "/usr/local/bin/npx",
    "/usr/local/bin/yarn",
    "/usr/local/bin/corepack",
  ])("rejects retained payloads or command links at %s", (path) => {
    const f = runtime();
    f.files.push({ location: { path }, contents: "" });
    expect(() => validateRuntimeTooling("api", f, policy)).toThrow(
      /payload or command/,
    );
  });
  it("rejects relocated package manager packages even without a known global path", () => {
    const f = runtime();
    f.artifacts.push({ name: "npm", version: "11.0.0", type: "npm" });
    expect(() => validateRuntimeTooling("worker", f, policy)).toThrow(
      /package manager/,
    );
  });
});
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
        {
          imageId: String(i),
          scope: "squashed",
          allLayers: { imageId: String(i), scope: "all-layers" },
        },
      ]),
    );
    const names = [
      "runtime-policy.json",
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
        ".layers.syft.json",
        ".layers.spdx.json",
        ".layers.grype.json",
        ".layers.notices.json",
        ".layers.review.json",
      ])
        names.push(target + suffix);
    for (const name of names) writeFileSync(join(directory, name), name);
    const report = {
      schemaVersion: 2,
      status: "complete",
      images,
      files: Object.fromEntries(names.map((n) => [n, hash(n)])),
    };
    expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
    expect(() =>
      verifyEvidenceFiles(directory, { ...report, schemaVersion: 1 }),
    ).toThrow(/schema/);
    images.api!.allLayers.scope = "squashed";
    expect(() => verifyEvidenceFiles(directory, report)).toThrow(
      /layer evidence/,
    );
    images.api!.allLayers.scope = "all-layers";
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

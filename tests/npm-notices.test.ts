import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../scripts/distribution/evidence.mjs";
import {
  npmTargets,
  validateNpmModuleNotices,
  validateNpmNoticeInventory,
  verifyNpmNoticeReports,
} from "../scripts/distribution/npm-notices.mjs";

function fixture() {
  const layerID = "sha256:" + "a".repeat(64);
  const secondLayer = "sha256:" + "b".repeat(64);
  const original =
    "Original publisher attribution\r\nCopyright fixture author\r\n";
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const file = (
    path: string,
    content: string,
    layer = layerID,
    capture = true,
  ) => ({
    id: hash(path + layer),
    location: { path, layerID: layer },
    metadata: { type: "RegularFile", size: Buffer.byteLength(content) },
    digests: [{ algorithm: "sha256", value: hash(content) }],
    ...(capture ? { contents: Buffer.from(content).toString("base64") } : {}),
  });
  const pin = (path: string, content: string) => ({
    path,
    size: Buffer.byteLength(content),
    sha256: hash(content),
  });
  const packageEntry = (name: string, version: string, path: string) => ({
    id: hash(name),
    name,
    version,
    type: "npm",
    licenses: [],
    locations: [{ path, layerID }],
  });
  const packages = [
    packageEntry("alpha", "1.0.0", "/app/node_modules/alpha/package.json"),
    packageEntry("bundle", "2.0.0", "/app/node_modules/bundle/package.json"),
    packageEntry(
      "bundle/entry",
      "UNKNOWN",
      "/app/node_modules/bundle/entry/package.json",
    ),
    packageEntry(
      "ordinary",
      "1.0.0",
      "/app/node_modules/ordinary/package.json",
    ),
    packageEntry("@pdaa/api", "0.1.0", "/app/package.json"),
  ];
  const manifest = (p: { name: string; version: string }) =>
    JSON.stringify({
      name: p.name,
      ...(p.version === "UNKNOWN" ? {} : { version: p.version }),
    });
  const files = packages.map((p) =>
    file(p.locations[0]!.path, manifest(p), layerID, false),
  );
  files.push(
    file("/app/node_modules/alpha/README.md", original),
    file("/app/node_modules/bundle/LICENSE.txt", original),
    file("/app/node_modules/ordinary/LICENSE", "Another original notice\n"),
  );
  const expected = {
    packages: packages
      .filter((p) => p.version !== "UNKNOWN")
      .map((p) => ({ name: p.name, version: p.version })),
  };
  files.push(file("/app/runtime-inventory.json", JSON.stringify(expected)));
  const inventory = {
    schemaVersion: 1,
    reviewRequired: true,
    packages: packages.slice(0, 2).map((p, i) => ({
      name: p.name,
      version: p.version,
      integrity,
      targets: [...npmTargets],
      source: {
        archive: `https://registry.npmjs.org/${p.name}/-/${p.name}-${p.version}.tgz`,
        sha256: hash("source " + p.name),
      },
      manifest: pin("package.json", manifest(p)),
      notices: [pin(i === 0 ? "README.md" : "LICENSE.txt", original)],
      embeddedManifests:
        i === 0
          ? []
          : [
              {
                name: "bundle/entry",
                manifest: pin("entry/package.json", manifest(packages[2]!)),
              },
            ],
    })),
  };
  const config = {
    os: "linux",
    architecture: "amd64",
    rootfs: { diff_ids: [layerID, secondLayer] },
  };
  const configBytes = Buffer.from(JSON.stringify(config));
  const imageId = "sha256:" + hash(configBytes);
  const inspection = {
    Id: imageId,
    Os: "linux",
    Architecture: "amd64",
    RootFS: { Layers: [layerID, secondLayer] },
  };
  const sbom = {
    descriptor: { configuration: { search: { scope: "squashed" } } },
    source: {
      type: "image",
      metadata: {
        userInput: imageId,
        imageID: imageId,
        config: configBytes.toString("base64"),
      },
    },
    artifacts: packages,
    files,
  };
  const locked = new Map(
    packages
      .filter((p) => p.version !== "UNKNOWN" && !p.name.startsWith("@pdaa/"))
      .map((p) => [`${p.name}@${p.version}`, integrity]),
  );
  return {
    layerID,
    secondLayer,
    original,
    file,
    inventory,
    expected,
    sbom,
    inspection,
    locked,
  };
}
type Fixture = ReturnType<typeof fixture>;
const inventoryBytes = (f: Fixture) => Buffer.from(JSON.stringify(f.inventory));
const run = (f: Fixture, target = "api") =>
  validateNpmModuleNotices({
    target,
    sbom: f.sbom,
    inspection: f.inspection,
    inventoryBytes: inventoryBytes(f),
    locked: f.locked,
  });
function rewriteRuntime(f: Fixture) {
  const index = f.sbom.files.findIndex(
    (file) => file.location.path === "/app/runtime-inventory.json",
  );
  f.sbom.files[index] = f.file(
    "/app/runtime-inventory.json",
    JSON.stringify(f.expected),
  );
}

describe("source-bound npm notices", () => {
  it.each(["squashed", "all-layers"])(
    "preserves original README bytes and explicit parent attribution in %s",
    (scope) => {
      const f = fixture();
      f.sbom.descriptor.configuration.search.scope = scope;
      const before = structuredClone(f.sbom);
      const result = run(f);
      expect(result.missingPackageNotices).toEqual([]);
      expect(result.npmNotices.directNoticeGaps).toHaveLength(2);
      expect(result.npmNotices.occurrences).toHaveLength(4);
      const child = result.npmNotices.occurrences.find(
        (p: { reportedName: string }) => p.reportedName === "bundle/entry",
      )!;
      expect(child).toMatchObject({
        reportedVersion: "UNKNOWN",
        attribution: "pinned-parent-notices",
        owner: { name: "bundle", version: "2.0.0" },
        reviewRequired: true,
      });
      expect(child.notices[0].path).toBe(
        "/app/node_modules/bundle/LICENSE.txt",
      );
      expect(
        Buffer.from(
          result.notices.find((n: { path: string }) =>
            n.path.endsWith("/README.md"),
          )!.contents,
          "base64",
        ).toString(),
      ).toBe(f.original);
      expect(f.sbom).toEqual(before);
    },
  );

  it("rejects absent capture, substituted bytes and original metadata changes", () => {
    for (const kind of [
      "capture",
      "bytes",
      "digest",
      "size",
      "link",
      "duplicate-digest",
    ] as const) {
      const f = fixture();
      const notice = f.sbom.files.find((file) =>
        file.location.path.endsWith("/README.md"),
      )!;
      if (kind === "capture") delete notice.contents;
      if (kind === "bytes")
        notice.contents = Buffer.from("substituted attribution").toString(
          "base64",
        );
      if (kind === "digest") notice.digests[0]!.value = hash("different");
      if (kind === "size") notice.metadata.size++;
      if (kind === "link") notice.metadata.type = "SymbolicLink";
      if (kind === "duplicate-digest")
        notice.digests.push({ ...notice.digests[0]! });
      expect(() => run(f), kind).toThrow(/content|source|digest|regular/);
    }
  });

  it("requires each selected package and entrypoint even if inventory observations disappear", () => {
    for (const name of ["alpha", "bundle/entry"]) {
      const f = fixture();
      const removed = f.sbom.artifacts.find((p) => p.name === name)!;
      f.sbom.artifacts = f.sbom.artifacts.filter((p) => p !== removed);
      f.sbom.files = f.sbom.files.filter(
        (file) => file.location.path !== removed.locations[0]!.path,
      );
      f.expected.packages = f.expected.packages.filter((p) => p.name !== name);
      rewriteRuntime(f);
      expect(() => run(f)).toThrow(
        /pinned npm package missing|entrypoint missing/,
      );
    }
  });

  it("rejects wrong source integrity, parent version and pinned manifest bytes", () => {
    const integrity = fixture();
    integrity.locked.set(
      "bundle@2.0.0",
      "sha512-" + Buffer.alloc(64, 2).toString("base64"),
    );
    expect(() => run(integrity)).toThrow(/integrity/);
    const version = fixture();
    version.sbom.artifacts[1]!.version = "2.1.0";
    version.expected.packages[1]!.version = "2.1.0";
    version.locked.set("bundle@2.1.0", version.locked.get("bundle@2.0.0")!);
    rewriteRuntime(version);
    expect(() => run(version)).toThrow(/version differs/);
    for (const path of [
      "/app/node_modules/bundle/package.json",
      "/app/node_modules/bundle/entry/package.json",
    ]) {
      const f = fixture();
      const file = f.sbom.files.find((p) => p.location.path === path)!;
      file.digests[0]!.value = hash("substituted manifest");
      expect(() => run(f)).toThrow(/source hash/);
    }
  });

  it("does not borrow a missing parent notice from another layer", () => {
    const f = fixture();
    const parentNotice = f.sbom.files.find((file) =>
      file.location.path.endsWith("bundle/LICENSE.txt"),
    )!;
    parentNotice.location.layerID = f.secondLayer;
    expect(() => run(f)).toThrow(/supplying layer/);
    const child = fixture();
    child.sbom.artifacts[2]!.locations[0]!.layerID = child.secondLayer;
    child.sbom.files.find((file) =>
      file.location.path.endsWith("entry/package.json"),
    )!.location.layerID = child.secondLayer;
    expect(() => run(child)).toThrow(
      /entrypoint missing|physical locked parent/,
    );
  });

  it("keeps child-specific notices without lending them to the parent", () => {
    const f = fixture();
    f.sbom.files.push(
      f.file(
        "/app/node_modules/bundle/entry/NOTICE",
        "Child-specific original attribution\n",
      ),
    );
    const occurrences = run(f).npmNotices.occurrences;
    const child = occurrences.find(
      (p: { reportedName: string }) => p.reportedName === "bundle/entry",
    )!;
    const parent = occurrences.find(
      (p: { reportedName: string }) => p.reportedName === "bundle",
    )!;
    expect(child.notices.map((n: { path: string }) => n.path)).toEqual([
      "/app/node_modules/bundle/entry/NOTICE",
      "/app/node_modules/bundle/LICENSE.txt",
    ]);
    expect(parent.notices).toHaveLength(1);
    expect(child.directNoticeStatus).toBe("captured");
  });

  it("does not grant unreviewed versionless manifests their ancestor's license", () => {
    const f = fixture();
    const path = "/app/node_modules/ordinary/sub/package.json";
    f.sbom.artifacts.push({
      id: "sub",
      name: "ordinary/sub",
      version: "UNKNOWN",
      type: "npm",
      licenses: [],
      locations: [{ path, layerID: f.layerID }],
    });
    f.sbom.files.push(
      f.file(path, '{"name":"ordinary/sub"}', f.layerID, false),
    );
    expect(run(f).missingPackageNotices).toEqual([
      { id: "sub", name: "ordinary/sub", version: "UNKNOWN" },
    ]);
  });

  it("never borrows an unrelated nested dependency's notice", () => {
    const f = fixture();
    const path =
      "/app/node_modules/ordinary/node_modules/unrelated/package.json";
    f.sbom.artifacts.push({
      id: "unrelated",
      name: "unrelated",
      version: "1.0.0",
      type: "npm",
      licenses: [],
      locations: [{ path, layerID: f.layerID }],
    });
    f.expected.packages.push({ name: "unrelated", version: "1.0.0" });
    f.locked.set("unrelated@1.0.0", f.locked.get("ordinary@1.0.0")!);
    rewriteRuntime(f);
    f.sbom.files = f.sbom.files.filter(
      (file) => file.location.path !== "/app/node_modules/ordinary/LICENSE",
    );
    f.sbom.files.push(
      f.file(path, '{"name":"unrelated","version":"1.0.0"}', f.layerID, false),
      f.file(
        path.replace("package.json", "LICENSE"),
        "Unrelated dependency original notice\n",
      ),
    );
    expect(run(f).missingPackageNotices).toEqual([
      { id: hash("ordinary"), name: "ordinary", version: "1.0.0" },
    ]);
  });

  it("rejects cross-node_modules inheritance and ambiguous physical manifests", () => {
    const f = fixture();
    const path = "/app/node_modules/bundle/node_modules/other/package.json";
    f.sbom.artifacts[2]!.locations[0]!.path = path;
    f.sbom.files[2]!.location.path = path;
    expect(() => run(f)).toThrow(/parent/);
    const duplicate = fixture();
    duplicate.sbom.artifacts.push({
      ...structuredClone(duplicate.sbom.artifacts[0]!),
      id: "duplicate",
    });
    expect(() => run(duplicate)).toThrow(/Ambiguous npm manifest ownership/);
  });

  it("preserves repeated package coordinates in distinct supplying layers", () => {
    const f = fixture();
    const path = "/app/node_modules/alpha/package.json";
    f.sbom.artifacts[0]!.locations.push({ path, layerID: f.secondLayer });
    f.sbom.files.push(
      f.file(path, '{"name":"alpha","version":"1.0.0"}', f.secondLayer, false),
      f.file("/app/node_modules/alpha/README.md", f.original, f.secondLayer),
    );
    const result = run(f);
    const copies = result.npmNotices.occurrences.filter(
      (p: { reportedName: string }) => p.reportedName === "alpha",
    );
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((p: { key: string }) => p.key)).size).toBe(2);
    expect(
      new Set(
        copies.map(
          (p: { manifest: { layerID: string } }) => p.manifest.layerID,
        ),
      ),
    ).toEqual(new Set([f.layerID, f.secondLayer]));
  });

  it("rejects noncanonical paths, duplicate native files and incorrect image identity", () => {
    const path = fixture();
    path.sbom.files[0]!.location.path =
      "/app/node_modules/alpha/../package.json";
    expect(() => run(path)).toThrow(/canonical|path/);
    const duplicate = fixture();
    duplicate.sbom.files.push(structuredClone(duplicate.sbom.files[0]!));
    expect(() => run(duplicate)).toThrow(/Duplicate npm file/);
    const image = fixture();
    image.inspection.Id = "sha256:" + "c".repeat(64);
    expect(() => run(image)).toThrow(/image differs/);
    const layers = fixture();
    layers.inspection.RootFS.Layers.pop();
    expect(() => run(layers)).toThrow(/layers differ/);
  });

  it("requires an explicit and unambiguous original-source policy", () => {
    const variants = [
      (f: Fixture) => {
        f.inventory.reviewRequired = false;
      },
      (f: Fixture) => {
        f.inventory.schemaVersion = 2;
      },
      (f: Fixture) => {
        f.inventory.packages.push(structuredClone(f.inventory.packages[0]!));
      },
      (f: Fixture) => {
        f.inventory.packages[0]!.notices = [];
      },
      (f: Fixture) => {
        f.inventory.packages[0]!.notices[0]!.path = "../README.md";
      },
      (f: Fixture) => {
        f.inventory.packages[0]!.notices[0]!.path =
          "node_modules/other/LICENSE";
      },
      (f: Fixture) => {
        f.inventory.packages[0]!.notices[0]!.size = 129 * 1024;
      },
      (f: Fixture) => {
        f.inventory.packages[0]!.source.archive =
          "https://example.com/package.tgz";
      },
    ];
    for (const mutate of variants) {
      const f = fixture();
      mutate(f);
      expect(() => validateNpmNoticeInventory(inventoryBytes(f))).toThrow();
    }
  });
});

function withEvidence(
  check: (directory: string, report: ReturnType<typeof buildEvidence>) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-npm-evidence-"));
  try {
    check(directory, buildEvidence(directory));
  } finally {
    for (const name of readdirSync(directory))
      unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
}
function buildEvidence(directory: string) {
  const f = fixture();
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value));
  write("npm-notices.json", f.inventory);
  const lockEntries = [...f.locked].map(([coordinate, integrity]) => ({
    coordinate,
    integrity,
  }));
  write("lock-inventory.json", lockEntries);
  write("pnpm-lock.yaml", {
    lockfileVersion: "9.0",
    packages: Object.fromEntries(
      lockEntries.map((p) => [
        p.coordinate,
        { resolution: { integrity: p.integrity } },
      ]),
    ),
  });
  const images = Object.fromEntries(
    npmTargets.map((target: string) => {
      write(target + ".image.json", f.inspection);
      const scopes = ["squashed", "all-layers"].map((scope) => {
        const sbom = structuredClone(f.sbom);
        sbom.descriptor.configuration.search.scope = scope;
        const { notices, ...result } = validateNpmModuleNotices({
          target,
          sbom,
          inspection: f.inspection,
          inventoryBytes: inventoryBytes(f),
          locked: f.locked,
        });
        const suffix = scope === "squashed" ? "" : ".layers";
        write(target + suffix + ".syft.json", sbom);
        write(target + suffix + ".notices.json", notices);
        return { imageId: f.inspection.Id, scope, ...result };
      });
      const image = { ...scopes[0]!, allLayers: scopes[1]! };
      write(target + ".review.json", image);
      write(target + ".layers.review.json", image.allLayers);
      return [target, image];
    }),
  );
  return { images, distributionAccepted: false };
}

describe("retained npm notice evidence", () => {
  it("recomputes original-byte and parent attribution for every target and scope", () =>
    withEvidence((directory, report) => {
      expect(() => verifyNpmNoticeReports(directory, report)).not.toThrow();
      expect(report.distributionAccepted).toBe(false);
    }));

  it("rejects a missing parent license despite edited coverage claims", () =>
    withEvidence((directory, report) => {
      const path = join(directory, "api.syft.json");
      const sbom = JSON.parse(readFileSync(path, "utf8"));
      sbom.files = sbom.files.filter(
        (f: { location: { path: string } }) =>
          f.location.path !== "/app/node_modules/bundle/LICENSE.txt",
      );
      writeFileSync(path, JSON.stringify(sbom));
      report.images.api!.npmNotices.occurrences = [];
      report.images.api!.missingPackageNotices = [];
      writeFileSync(
        join(directory, "api.review.json"),
        JSON.stringify(report.images.api),
      );
      writeFileSync(join(directory, "api.notices.json"), "[]");
      expect(() => verifyNpmNoticeReports(directory, report)).toThrow(
        /source file missing/,
      );
    }));

  it("rejects dropped retained originals and altered reports independently", () => {
    withEvidence((directory, report) => {
      writeFileSync(join(directory, "worker.layers.notices.json"), "[]");
      expect(() => verifyNpmNoticeReports(directory, report)).toThrow(
        /Retained original npm notices/,
      );
    });
    withEvidence((directory, report) => {
      report.images.api!.allLayers.npmNotices = report.images.api!.npmNotices;
      writeFileSync(
        join(directory, "api.review.json"),
        JSON.stringify(report.images.api),
      );
      expect(() => verifyNpmNoticeReports(directory, report)).toThrow(
        /Recorded npm reconciliation/,
      );
    });
    withEvidence((directory, report) => {
      const path = join(directory, "operations.review.json");
      const review = JSON.parse(readFileSync(path, "utf8"));
      review.npmNotices.reviewRequired = false;
      writeFileSync(path, JSON.stringify(review));
      expect(() => verifyNpmNoticeReports(directory, report)).toThrow(
        /Retained npm review/,
      );
    });
  });

  it("reconciles archived lockfile bytes rather than trusting a derived inventory", () =>
    withEvidence((directory, report) => {
      const path = join(directory, "lock-inventory.json");
      const entries = JSON.parse(readFileSync(path, "utf8"));
      entries[0].integrity = "sha512-" + Buffer.alloc(64, 3).toString("base64");
      writeFileSync(path, JSON.stringify(entries));
      expect(() => verifyNpmNoticeReports(directory, report)).toThrow(
        /lock inventory differs/,
      );
    }));
});

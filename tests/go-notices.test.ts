import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../scripts/distribution/evidence.mjs";
import {
  goNoticeIndex,
  goNoticeRoot,
  isGoNoticePath,
  validateGoModuleNotices,
  validateGoNoticeInventory,
  verifyGoNoticeReports,
} from "../scripts/distribution/go-notices.mjs";

function fixture() {
  const layerID = "sha256:" + "a".repeat(64);
  const original = "Original attribution\r\n";
  const text = (path: string) => ({
    path,
    size: Buffer.byteLength(original),
    sha256: hash(original),
  });
  const modules = [
    {
      path: "example.com/Case/module/v2",
      version: "v2.0.0",
      sum: "h1:" + Buffer.alloc(32, 1).toString("base64"),
      notices: [
        text("LICENSE"),
        text("LICENSES/MIT.txt"),
        text("nested/NOTICE"),
      ],
    },
    {
      path: "github.com/caddyserver/caddy/v2",
      version: "v2.11.4",
      sum: "h1:" + Buffer.alloc(32, 2).toString("base64"),
      notices: [text("LICENSE")],
    },
  ];
  const binary = {
    path: "/usr/bin/caddy",
    sha256: hash("compiled fixture"),
    goVersion: "go1.26.8",
    mainModule: "github.com/caddyserver/caddy/v2",
    buildSettings: {
      GOOS: "linux",
      GOARCH: "amd64",
      CGO_ENABLED: "0",
      "-trimpath": "true",
      "-tags": "nobadger,nomysql,nopgx",
    },
  };
  const inventory = { schemaVersion: 1, reviewRequired: true, binary, modules };
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  const index = {
    schemaVersion: 1,
    reviewRequired: true,
    coverage: "module-source-notice-superset",
    sourceMethod: "offline-cache-zip-h1",
    inventorySha256: hash(inventoryBytes),
    binary: structuredClone(binary),
    modules: modules.map((m) => ({
      ...m,
      zipSha256: hash(m.path),
      noticeStatus: "collected",
      notices: m.notices.map((n) => ({
        ...n,
        shippedPath: `${goNoticeRoot}/${hash(m.path + "@" + m.version)}/${n.path}`,
      })),
    })),
  };
  const file = (path: string, content: string) => ({
    id: hash(path),
    location: { path, layerID },
    metadata: { type: "RegularFile", size: Buffer.byteLength(content) },
    digests: [{ algorithm: "sha256", value: hash(content) }],
    contents: Buffer.from(content).toString("base64"),
  });
  const sbom = {
    descriptor: { configuration: { search: { scope: "squashed" } } },
    artifacts: [
      ...modules.map((m) => ({
        id: hash(m.path),
        type: "go-module",
        name: m.path,
        version: m.version,
        metadata: {
          h1Digest: m.sum,
          goCompiledVersion: binary.goVersion,
          mainModule: binary.mainModule,
          goBuildSettings:
            m.path === binary.mainModule
              ? Object.entries(binary.buildSettings).map(([key, value]) => ({
                  key,
                  value,
                }))
              : [],
        },
        locations: [{ path: binary.path, layerID }],
      })),
      {
        id: "stdlib",
        type: "go-module",
        name: "stdlib",
        version: binary.goVersion,
        metadata: {
          h1Digest: "",
          goCompiledVersion: binary.goVersion,
          mainModule: binary.mainModule,
          goBuildSettings: [],
        },
        locations: [{ path: binary.path, layerID }],
      },
    ],
    files: [
      file(binary.path, "compiled fixture"),
      file(goNoticeIndex, JSON.stringify(index)),
      ...index.modules.flatMap((m) =>
        m.notices.map((n) => file(n.shippedPath, original)),
      ),
    ],
  };
  return { inventory, inventoryBytes, index, sbom };
}
function rewriteIndex(f: ReturnType<typeof fixture>) {
  const file = f.sbom.files.find(
    (file) => file.location.path === goNoticeIndex,
  )!;
  const text = JSON.stringify(f.index);
  file.contents = Buffer.from(text).toString("base64");
  file.digests[0]!.value = hash(text);
  file.metadata.size = Buffer.byteLength(text);
}

describe("compiled Go source notice evidence", () => {
  it("reconciles original nested attribution in both immutable scopes, keeping module identity", () => {
    for (const scope of ["squashed", "all-layers"]) {
      const f = fixture();
      f.sbom.descriptor.configuration.search.scope = scope;
      const result = validateGoModuleNotices(f.sbom, f.inventoryBytes);
      expect(result).toMatchObject({
        scope,
        moduleCount: 2,
        modulesWithNotices: 2,
        noticeFiles: 4,
        reviewRequired: true,
      });
      expect(result.modules[0]!.notices).toHaveLength(3);
      expect(result.modules[0]!.notices[0]!.sha256).toBe(
        result.modules[1]!.notices[0]!.sha256,
      );
      expect(result.modules[0]!.notices[0]!.shippedPath).not.toBe(
        result.modules[1]!.notices[0]!.shippedPath,
      );
    }
  });
  it("rejects omitted nested notices even when removed from the manifest and filesystem together", () => {
    const f = fixture();
    const removed = f.index.modules[0]!.notices.pop()!;
    f.sbom.files = f.sbom.files.filter(
      (file) => file.location.path !== removed.shippedPath,
    );
    rewriteIndex(f);
    expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow(
      /notice coverage/,
    );
  });
  it("rejects missing or modified notice bytes independently of a self-consistent file digest", () => {
    for (const mode of [
      "missing",
      "altered",
      "content-only",
      "uncaptured",
      "wrong-size",
      "symlink",
    ]) {
      const f = fixture();
      const notice = f.sbom.files[2]!;
      if (mode === "missing") f.sbom.files.splice(2, 1);
      if (mode === "altered" || mode === "content-only")
        notice.contents = Buffer.from("changed attribution\r\n").toString(
          "base64",
        );
      if (mode === "altered") {
        notice.metadata.size = Buffer.from(notice.contents, "base64").length;
        notice.digests[0]!.value = hash(Buffer.from(notice.contents, "base64"));
      }
      if (mode === "uncaptured") Reflect.deleteProperty(notice, "contents");
      if (mode === "wrong-size") notice.metadata.size++;
      if (mode === "symlink") notice.metadata.type = "SymbolicLink";
      expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow();
    }
  });
  it("rejects changed, omitted, additional and duplicate compiled module records", () => {
    for (const mode of [
      "version",
      "sum",
      "missing",
      "additional",
      "duplicate",
      "main-module",
      "compiler",
      "stdlib",
    ]) {
      const f = fixture();
      const module = f.sbom.artifacts[0]!;
      if (mode === "version") module.version = "v2.0.1";
      if (mode === "sum")
        module.metadata.h1Digest =
          "h1:" + Buffer.alloc(32, 3).toString("base64");
      if (mode === "missing") f.sbom.artifacts.shift();
      if (mode === "additional")
        f.sbom.artifacts.push({
          ...module,
          id: "other",
          name: "example.com/extra",
        });
      if (mode === "duplicate") f.sbom.artifacts[1] = structuredClone(module);
      if (mode === "main-module")
        module.metadata.mainModule = "example.com/other";
      if (mode === "compiler") module.metadata.goCompiledVersion = "go1.26.3";
      if (mode === "stdlib") f.sbom.artifacts[2]!.version = "go1.26.3";
      expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow();
    }
  });
  it("rejects unrelated binary and manifest identities and changes to build settings", () => {
    for (const mode of [
      "binary",
      "manifest-binary",
      "inventory",
      "manifest-module",
      "settings",
      "duplicate-setting",
    ]) {
      const f = fixture();
      if (mode === "binary")
        f.sbom.files[0]!.digests[0]!.value = hash("unrelated binary");
      if (mode === "manifest-binary")
        f.index.binary.sha256 = hash("unrelated binary");
      if (mode === "inventory")
        f.index.inventorySha256 = hash("other inventory");
      if (mode === "manifest-module")
        f.index.modules[0]!.sum =
          "h1:" + Buffer.alloc(32, 3).toString("base64");
      const settings = f.sbom.artifacts[1]!.metadata.goBuildSettings;
      if (mode === "settings")
        settings.find((s) => s.key === "CGO_ENABLED")!.value = "1";
      if (mode === "duplicate-setting") settings.push(settings[0]!);
      rewriteIndex(f);
      expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow();
    }
  });
  it("rejects missing, substituted and additional lower-layer copies", () => {
    for (const mode of [
      "binary",
      "index",
      "notice",
      "module-location",
      "file-layer",
      "notice-layer",
      "index-layer",
    ]) {
      const f = fixture();
      f.sbom.descriptor.configuration.search.scope = "all-layers";
      if (["binary", "index", "notice"].includes(mode)) {
        const file = structuredClone(
          f.sbom.files[mode === "binary" ? 0 : mode === "index" ? 1 : 2]!,
        );
        file.id += "old";
        file.location.layerID = "sha256:" + "b".repeat(64);
        f.sbom.files.push(file);
      }
      if (mode === "module-location")
        f.sbom.artifacts[0]!.locations.push({
          path: "/opt/old-caddy",
          layerID: "sha256:" + "b".repeat(64),
        });
      if (mode === "file-layer")
        f.sbom.artifacts[0]!.locations[0]!.layerID = "sha256:" + "b".repeat(64);
      if (mode === "notice-layer")
        f.sbom.files[2]!.location.layerID = "sha256:" + "b".repeat(64);
      if (mode === "index-layer")
        f.sbom.files[1]!.location.layerID = "sha256:" + "b".repeat(64);
      expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow();
    }
  });
  it("rejects cache/source leaks and unsafe or unexpected shipped paths", () => {
    for (const path of [
      "/go/pkg/mod/example.zip",
      "/notice-collector/main.go",
      `${goNoticeRoot}/unexpected.txt`,
    ]) {
      const f = fixture();
      f.sbom.files.push({
        ...f.sbom.files[2]!,
        location: { ...f.sbom.files[2]!.location, path },
      });
      expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow(
        /leaked|Unexpected/,
      );
    }
    const f = fixture();
    f.index.modules[0]!.notices[0]!.shippedPath =
      "/usr/share/caddy/modules/../LICENSE";
    rewriteIndex(f);
    expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow(
      /inventory differs/,
    );
  });
  it("keeps review mandatory and distinguishes missing notices from collected originals", () => {
    const f = fixture();
    f.index.reviewRequired = false;
    rewriteIndex(f);
    expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow(
      /cannot be waived/,
    );
    f.index.reviewRequired = true;
    f.index.modules[0]!.noticeStatus = "missing";
    rewriteIndex(f);
    expect(() => validateGoModuleNotices(f.sbom, f.inventoryBytes)).toThrow();
  });
  it("rejects invalid pinned coordinates, duplicate entries and notice traversal", () => {
    for (const mode of [
      "coordinate",
      "sum",
      "duplicate",
      "traversal",
      "notice-duplicate",
      "source",
      "approval",
      "settings",
    ]) {
      const f = fixture();
      if (mode === "coordinate") f.inventory.modules[0]!.path = "../escape";
      if (mode === "sum") f.inventory.modules[0]!.sum = "";
      if (mode === "duplicate")
        f.inventory.modules.push(f.inventory.modules[0]!);
      if (mode === "traversal")
        f.inventory.modules[0]!.notices[0]!.path = "../LICENSE";
      if (mode === "notice-duplicate")
        f.inventory.modules[0]!.notices.push(
          f.inventory.modules[0]!.notices[0]!,
        );
      if (mode === "source")
        f.inventory.modules[0]!.notices[0]!.path = "LICENSE.go";
      if (mode === "approval") f.inventory.reviewRequired = false;
      if (mode === "settings")
        f.inventory.binary.buildSettings.CGO_ENABLED = "1";
      expect(() =>
        validateGoNoticeInventory(Buffer.from(JSON.stringify(f.inventory))),
      ).toThrow();
    }
  });
  it("captures text attribution forms and excludes the demonstrated JSON fixture and source files", () => {
    for (const path of [
      "COPYING.BSD",
      "AUTHORS",
      "PATENTS",
      "THIRD_PARTY_NOTICES.txt",
      "LICENSES/MIT.txt",
    ])
      expect(isGoNoticePath(path)).toBe(true);
    for (const path of [
      "license.go",
      "testdata/license.json",
      "NOTICE.pdf",
      "LICENSES/source.js",
    ])
      expect(isGoNoticePath(path)).toBe(false);
  });
  it("rechecks both retained native reports instead of trusting recorded coverage counts", () => {
    const directory = mkdtempSync(join(tmpdir(), "pdaa-go-notices-"));
    const files = [
      "caddy-modules.json",
      "web.syft.json",
      "web.layers.syft.json",
    ];
    try {
      const f = fixture();
      const layered = structuredClone(f.sbom);
      layered.descriptor.configuration.search.scope = "all-layers";
      writeFileSync(join(directory, files[0]!), f.inventoryBytes);
      writeFileSync(join(directory, files[1]!), JSON.stringify(f.sbom));
      writeFileSync(join(directory, files[2]!), JSON.stringify(layered));
      const report = {
        images: {
          web: {
            goNotices: validateGoModuleNotices(f.sbom, f.inventoryBytes),
            allLayers: {
              goNotices: validateGoModuleNotices(layered, f.inventoryBytes),
            },
          },
        },
      };
      expect(() => verifyGoNoticeReports(directory, report)).not.toThrow();
      report.images.web.allLayers.goNotices.noticeFiles = 0;
      expect(() => verifyGoNoticeReports(directory, report)).toThrow(
        /reconciliation differs/,
      );
    } finally {
      for (const file of files) unlinkSync(join(directory, file));
      rmdirSync(directory);
    }
  });
});

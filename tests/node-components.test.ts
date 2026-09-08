import { describe, expect, it, vi } from "vitest";
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
import {
  hash,
  verifyEvidenceFiles,
} from "../scripts/distribution/evidence.mjs";
import {
  captureNodeMetadata,
  nodeProbeArgs,
  nodeTargets,
  validateNodeComponentEvidence,
  validateNodeImage,
  validateNodePolicy,
  verifyNodeComponentReports,
} from "../scripts/distribution/node-components.mjs";

const committedPolicy = JSON.parse(
  readFileSync("scripts/distribution/node-components.json", "utf8"),
);
const originalRuntimePolicy = JSON.parse(
  readFileSync("scripts/distribution/runtime-policy.json", "utf8"),
);
const runId = "pdaa-distribution-1234567890-0123abcd";
import { nodeFixture as fixture } from "./fixtures/node-evidence.js";
type Fixture = ReturnType<typeof fixture>;
const policyBytes = (f: Fixture) => Buffer.from(JSON.stringify(f.policy));
function receiptFor(f: Fixture) {
  return {
    schemaVersion: 1,
    target: f.target,
    runId,
    imageId: f.inspection.Id,
    binarySha256: f.policy.binary.sha256,
    policySha256: hash(policyBytes(f)),
    command: {
      executable: "docker",
      args: nodeProbeArgs(f.target, f.inspection.Id, runId),
    },
    stdout: {
      file: `${f.target}.node-metadata.json`,
      size: f.metadataBytes.length,
      sha256: hash(f.metadataBytes),
    },
    exitCode: 0,
    stderrBytes: 0,
    reviewRequired: true,
  };
}
const run = (f: Fixture, receipt = receiptFor(f)) =>
  validateNodeComponentEvidence({
    target: f.target,
    inspection: f.inspection,
    sbom: f.sbom,
    policyBytes: policyBytes(f),
    metadataBytes: f.metadataBytes,
    receipt,
    runId,
  });

describe("Node binary and original source coverage", () => {
  it.each(["squashed", "all-layers"])(
    "reconciles all original spans and metadata in %s",
    (scope) => {
      const f = fixture("api", scope),
        before = structuredClone(f.sbom);
      const result = run(f);
      expect(result.components).toHaveLength(29);
      expect(result.sourceSections).toHaveLength(44);
      expect(result.unrepresentedComponents).toEqual([
        "nbytes",
        "ncrypto",
        "sqlite",
      ]);
      expect(
        result.sourceSections.filter(
          (s: { membership: string }) =>
            s.membership === "unresolved-source-only",
        ),
      ).toHaveLength(24);
      expect(
        result.components.find(
          (c: { metadataKey: string }) => c.metadataKey === "undici",
        ).identity,
      ).toMatch(/^node-library:undici@/);
      expect(
        result.components.find(
          (c: { metadataKey: string }) => c.metadataKey === "node",
        ).attribution,
      ).toBe("original-node-preamble");
      expect(
        result.components.find(
          (c: { metadataKey: string }) => c.metadataKey === "cldr",
        ).attribution,
      ).toBe("unresolved-data-attribution");
      expect(
        result.components.find(
          (c: { metadataKey: string }) => c.metadataKey === "ngtcp2",
        ),
      ).toMatchObject({
        kind: "disabled",
        version: "",
        attribution: "original-source-section-feature-disabled",
      });
      expect(
        result.sourceSections.find((s: { name: string }) => s.name === "npm")
          .membership,
      ).toBe("unresolved-source-only");
      expect(f.policy.metadata.config.variables.node_install_npm).toBe(true);
      expect(f.sbom).toEqual(before);
    },
  );
  it("preserves operations' valid distinct binary and notice layers", () => {
    const f = fixture("operations");
    const result = run(f);
    expect(result.binary.layerID).not.toBe(result.notice.layerID);
  });
  it.each([
    [
      "same-version changed binary",
      (f: Fixture) => {
        f.binary.digests[0]!.value = hash("changed binary");
      },
    ],
    [
      "missing executable",
      (f: Fixture) => {
        f.sbom.files.splice(0, 1);
      },
    ],
    [
      "unclassified renamed binary copy",
      (f: Fixture) => {
        f.sbom.files.push(
          f.file("/opt/old/runtime", f.binaryBytes, f.secondLayer, false),
        );
      },
    ],
    [
      "lower-layer executable copy",
      (f: Fixture) => {
        f.sbom.files.push(
          f.file(f.policy.binary.path, f.binaryBytes, f.secondLayer, false),
        );
      },
    ],
    [
      "duplicate binary classifier",
      (f: Fixture) => {
        f.sbom.artifacts.push({
          ...structuredClone(f.sbom.artifacts[0]!),
          id: "other-node",
        });
      },
    ],
    [
      "npm substitute",
      (f: Fixture) => {
        f.sbom.artifacts[0]!.type = "npm";
      },
    ],
    [
      "wrong package layer",
      (f: Fixture) => {
        f.sbom.artifacts[0]!.locations[0]!.layerID = f.secondLayer;
      },
    ],
    [
      "unknown source layer",
      (f: Fixture) => {
        f.notice.location.layerID = "sha256:" + "c".repeat(64);
      },
    ],
    [
      "wrong image input",
      (f: Fixture) => {
        f.sbom.source.metadata.userInput = "sha256:" + "c".repeat(64);
      },
    ],
    [
      "wrong image config",
      (f: Fixture) => {
        f.sbom.source.metadata.imageID = "sha256:" + "c".repeat(64);
      },
    ],
    [
      "mismatched filesystem",
      (f: Fixture) => {
        f.inspection.RootFS.Layers.reverse();
      },
    ],
    [
      "symlink notice",
      (f: Fixture) => {
        f.notice.metadata.type = "SymLink";
      },
    ],
    [
      "missing notice bytes",
      (f: Fixture) => {
        f.notice.contents = "";
      },
    ],
    [
      "forged notice bytes",
      (f: Fixture) => {
        f.notice.contents =
          Buffer.from("substituted notice").toString("base64");
      },
    ],
    [
      "wrong notice size",
      (f: Fixture) => {
        f.notice.metadata.size++;
      },
    ],
    [
      "notice from unrelated path",
      (f: Fixture) => {
        f.notice.location.path = "/opt/borrowed/LICENSE";
      },
    ],
    [
      "duplicate notice occurrence",
      (f: Fixture) => {
        f.sbom.files.push(
          f.file(f.notice.location.path, f.noticeBytes, f.secondLayer),
        );
      },
    ],
    [
      "duplicate file ID",
      (f: Fixture) => {
        f.notice.id = f.binary.id;
      },
    ],
    [
      "traversal binary path",
      (f: Fixture) => {
        f.binary.location.path = "/usr/local/bin/../bin/node";
      },
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => run(f)).toThrow();
  });
  it("rejects source-only section removal even after adjacent spans are coherently rehashed", () => {
    const f = fixture(),
      index = f.policy.notice.sections.findIndex(
        (s: { name: string }) => s.name === "ittapi",
      );
    const removed = f.policy.notice.sections.splice(index, 1)[0],
      previous = f.policy.notice.sections[index - 1];
    previous.end = removed.end;
    previous.sha256 = hash(
      f.noticeBytes.subarray(previous.start, previous.end),
    );
    expect(() => run(f)).toThrow(/section inventory/);
  });
  it.each([
    [
      "wrong source heading",
      (f: Fixture) => {
        f.policy.notice.sections[3].name = "Renamed source";
      },
    ],
    [
      "wrong source path",
      (f: Fixture) => {
        f.policy.notice.sections[3].sourcePath = "deps/other";
      },
    ],
    [
      "missing source proof",
      (f: Fixture) => {
        f.policy.source.files = f.policy.source.files.filter(
          (s: { path: string }) => s.path !== "src/node_metadata.cc",
        );
      },
    ],
    [
      "mutable source URL",
      (f: Fixture) => {
        f.policy.source.files[0].url =
          "https://raw.githubusercontent.com/nodejs/node/main/LICENSE";
      },
    ],
    [
      "section overlap",
      (f: Fixture) => {
        f.policy.notice.sections[1].start--;
      },
    ],
    [
      "borrowed existing component notice",
      (f: Fixture) => {
        f.policy.components.find(
          (c: { key: string }) => c.key === "acorn",
        ).noticeSection = "OpenSSL";
      },
    ],
    [
      "mismatched component source path",
      (f: Fixture) => {
        f.policy.components.find(
          (c: { key: string }) => c.key === "acorn",
        ).sourcePath = "deps/other";
      },
    ],
    [
      "missing disabled source notice",
      (f: Fixture) => {
        f.policy.components.find(
          (c: { key: string }) => c.key === "ngtcp2",
        ).noticeSection = null;
      },
    ],
    [
      "missing represented library notice",
      (f: Fixture) => {
        f.policy.components.find(
          (c: { key: string }) => c.key === "acorn",
        ).noticeSection = null;
      },
    ],
    [
      "missing key mapping",
      (f: Fixture) => {
        f.policy.components.pop();
      },
    ],
    [
      "borrowed missing notice",
      (f: Fixture) => {
        f.policy.components.find(
          (c: { key: string }) => c.key === "sqlite",
        ).noticeSection = "Acorn";
      },
    ],
    [
      "invented ABI library",
      (f: Fixture) => {
        f.policy.components.find(
          (c: { key: string }) => c.key === "modules",
        ).kind = "library";
      },
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => run(f)).toThrow();
  });
  it.each([
    [
      "missing key",
      (m: Fixture["policy"]["metadata"]) => {
        delete m.versions.acorn;
      },
    ],
    [
      "extra key",
      (m: Fixture["policy"]["metadata"]) => {
        m.versions.extra = "1";
      },
    ],
    [
      "wrong type",
      (m: Fixture["policy"]["metadata"]) => {
        m.versions.napi = 10;
      },
    ],
    [
      "disabled key omitted",
      (m: Fixture["policy"]["metadata"]) => {
        delete m.versions.nghttp3;
      },
    ],
    [
      "QUIC unexpectedly enabled",
      (m: Fixture["policy"]["metadata"]) => {
        m.features.quic = true;
      },
    ],
    [
      "wrong build configuration",
      (m: Fixture["policy"]["metadata"]) => {
        m.config.variables.node_shared_openssl = true;
      },
    ],
    [
      "wrong platform",
      (m: Fixture["policy"]["metadata"]) => {
        m.platform = "win32";
      },
    ],
    [
      "truncated V8 identity",
      (m: Fixture["policy"]["metadata"]) => {
        m.versions.v8 = m.versions.v8.split("-")[0];
      },
    ],
  ] as const)("rejects metadata with %s", (_label, mutate) => {
    const f = fixture(),
      metadata = JSON.parse(f.metadataBytes.toString());
    mutate(metadata);
    f.metadataBytes = Buffer.from(JSON.stringify(metadata));
    expect(() => run(f)).toThrow(/metadata differs/);
  });
  it("rejects malformed, duplicate-key, non-UTF8 and oversized raw probe output", () => {
    for (const bytes of [
      Buffer.from("{"),
      Buffer.from(
        '{"version":"v24.19.0",' +
          JSON.stringify(committedPolicy.metadata).slice(1),
      ),
      Buffer.from([255]),
      Buffer.alloc(128 * 1024 + 1, 32),
    ]) {
      const f = fixture();
      f.metadataBytes = bytes;
      expect(() => run(f)).toThrow();
    }
  });
  it("rejects another target's command receipt and rehashed weakened isolation", () => {
    const f = fixture(),
      receipt = receiptFor(f);
    receipt.target = "worker";
    expect(() => run(f, receipt)).toThrow(/receipt differs/);
    const weak = receiptFor(f);
    weak.command.args[weak.command.args.indexOf("--network") + 1] = "host";
    expect(() => run(f, weak)).toThrow(/receipt differs/);
  });
});

describe("bounded Node metadata collection", () => {
  it("validates the binary before executing and archives exact stdout", () => {
    const f = fixture();
    const execute = vi.fn(() => ({
      status: 0,
      stdout: f.metadataBytes,
      stderr: Buffer.alloc(0),
    }));
    const result = captureNodeMetadata({
      target: f.target,
      inspection: f.inspection,
      sbom: f.sbom,
      policyBytes: policyBytes(f),
      runId,
      env: {},
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.metadataBytes).toEqual(f.metadataBytes);
    expect(result.receipt).toEqual(receiptFor(f));
    expect(execute.mock.calls[0]).toEqual([
      "docker",
      nodeProbeArgs(f.target, f.inspection.Id, runId),
      expect.objectContaining({
        timeout: 30000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      }),
    ]);
    f.binary.digests[0]!.value = hash("wrong");
    execute.mockClear();
    expect(() =>
      captureNodeMetadata({
        target: f.target,
        inspection: f.inspection,
        sbom: f.sbom,
        policyBytes: policyBytes(f),
        runId,
        env: {},
        execute,
      }),
    ).toThrow(/binary hash/);
    expect(execute).not.toHaveBeenCalled();
  });
  it("cleans up only its uniquely named container after a bounded command failure", () => {
    const f = fixture();
    const execute = vi.fn(() => ({
      status: null,
      error: new Error("timeout"),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    expect(() =>
      captureNodeMetadata({
        target: f.target,
        inspection: f.inspection,
        sbom: f.sbom,
        policyBytes: policyBytes(f),
        runId,
        env: {},
        execute,
      }),
    ).toThrow(/probe failed/);
    expect(execute.mock.calls[1]).toEqual([
      "docker",
      ["rm", "-f", `${runId}-node-api`],
      expect.objectContaining({ timeout: 10000 }),
    ]);
  });
});

function withArchive(
  test: (
    directory: string,
    report: Record<string, unknown>,
    rewrite: (name: string, value: unknown) => void,
  ) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-node-evidence-"));
  const images: Record<string, unknown> = {};
  const hashes: Record<string, string> = {};
  const rewrite = (name: string, value: unknown) => {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(JSON.stringify(value));
    writeFileSync(join(directory, name), bytes);
    hashes[name] = hash(bytes);
  };
  try {
    const base = fixture();
    rewrite("node-components.json", policyBytes(base));
    rewrite("node-supplemental.json", Buffer.from("{}"));
    const runtime = {
      ...structuredClone(originalRuntimePolicy),
      nodeNoticeSha256: base.policy.notice.sha256,
    };
    const caddyNotice = Buffer.from("Synthetic original Caddy notice");
    for (const path of Object.keys(runtime.caddyNotices))
      runtime.caddyNotices[path] = hash(caddyNotice);
    rewrite("runtime-policy.json", runtime);
    for (const target of ["api", "worker", "operations", "web", "database"]) {
      const f = fixture(nodeTargets.includes(target) ? target : "api");
      if (!nodeTargets.includes(target))
        f.inspection.Id = "sha256:" + hash(target);
      rewrite(`${target}.image.json`, f.inspection);
      const review: Record<string, unknown> = {
        imageId: f.inspection.Id,
        scope: "squashed",
      };
      for (const [scope, suffix] of [
        ["squashed", ""],
        ["all-layers", ".layers"],
      ]) {
        const native = structuredClone(f.sbom);
        native.descriptor.configuration.search.scope = scope;
        const layerReview: Record<string, unknown> = {
          imageId: f.inspection.Id,
          scope,
        };
        if (nodeTargets.includes(target)) {
          const scoped = { ...f, sbom: native };
          layerReview.nodeComponents = run(scoped);
          rewrite(`${target}.node-metadata.json`, f.metadataBytes);
          rewrite(`${target}.node-receipt.json`, receiptFor(f));
        } else {
          native.artifacts = [];
          native.files = [];
          if (target === "web") {
            const web = JSON.parse(JSON.stringify(native));
            web.artifacts = [
              {
                name: "github.com/caddyserver/caddy/v2",
                type: "go-module",
                version: runtime.caddyVersion,
                metadata: {
                  goCompiledVersion: runtime.caddyGoVersion,
                  goBuildSettings: [
                    { key: "CGO_ENABLED", value: "0" },
                    { key: "-tags", value: runtime.caddyBuildTags.join(",") },
                  ],
                },
                locations: [{ path: "/usr/bin/caddy" }],
              },
              {
                name: "stdlib",
                type: "go-module",
                version: runtime.caddyGoVersion,
              },
            ];
            web.files = Object.keys(runtime.caddyNotices).map((path) =>
              f.file(path, caddyNotice),
            );
            Object.assign(native, web);
          }
        }
        rewrite(`${target}${suffix}.syft.json`, native);
        for (const ending of ["spdx.json", "grype.json", "notices.json"])
          rewrite(`${target}${suffix}.${ending}`, {});
        if (scope === "squashed") Object.assign(review, layerReview);
        else {
          review.allLayers = layerReview;
          rewrite(`${target}${suffix}.review.json`, layerReview);
        }
      }
      images[target] = review;
      rewrite(`${target}.review.json`, review);
    }
    for (const name of [
      "caddy-modules.json",
      "npm-notices.json",
      "pnpm-lock.yaml",
      "lock-inventory.json",
      "production-acceptance.json",
      "browser.syft.json",
      "browser.spdx.json",
      "browser.grype.json",
      "browser.scan-receipt.json",
    ])
      rewrite(name, {});
    const report = {
      schemaVersion: 6,
      runId,
      status: "complete",
      images,
      files: hashes,
    };
    test(directory, report, rewrite);
  } finally {
    for (const file of readdirSync(directory))
      unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
}
describe("retained Node evidence replay", () => {
  it("requires schema-5 raw receipts and reproduces each target and scope", () =>
    withArchive((directory, report) => {
      expect(Object.keys(report.files as object)).toHaveLength(73);
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() => verifyNodeComponentReports(directory, report)).not.toThrow();
      expect(() =>
        verifyEvidenceFiles(directory, { ...report, schemaVersion: 4 }),
      ).toThrow(/schema/);
    }));
  it("rejects a forged summary even when companion review and hashes agree", () =>
    withArchive((directory, report, rewrite) => {
      const images = report.images as Record<
        string,
        ReturnType<typeof JSON.parse>
      >;
      images.api.nodeComponents.components.pop();
      rewrite("api.review.json", images.api);
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() => verifyNodeComponentReports(directory, report)).toThrow(
        /Recorded Node component/,
      );
    }));
  it("rejects a rehashed raw metadata substitution", () =>
    withArchive((directory, report, rewrite) => {
      const bytes = readFileSync(join(directory, "api.node-metadata.json"));
      const metadata = JSON.parse(bytes.toString());
      metadata.versions.undici = "0.0.0";
      const changed = Buffer.from(JSON.stringify(metadata));
      rewrite("api.node-metadata.json", changed);
      const receipt = JSON.parse(
        readFileSync(join(directory, "api.node-receipt.json"), "utf8"),
      );
      receipt.stdout = {
        ...receipt.stdout,
        size: changed.length,
        sha256: hash(changed),
      };
      rewrite("api.node-receipt.json", receipt);
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() => verifyNodeComponentReports(directory, report)).toThrow(
        /metadata differs/,
      );
    }));
  it("replays package-manager exclusions against retained native files", () =>
    withArchive((directory, report, rewrite) => {
      const native = JSON.parse(
        readFileSync(join(directory, "worker.layers.syft.json"), "utf8"),
      );
      native.files.push({ location: { path: "/usr/local/bin/npm" } });
      rewrite("worker.layers.syft.json", native);
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() => verifyNodeComponentReports(directory, report)).toThrow(
        /Package manager payload/,
      );
    }));
});

it("validates the committed reviewed source/metadata policy", () => {
  const bytes = readFileSync("scripts/distribution/node-components.json");
  expect(validateNodePolicy(bytes).components).toHaveLength(29);
  expect(() =>
    validateNodeImage({
      target: "web",
      inspection: {},
      sbom: {},
      policyBytes: bytes,
    }),
  ).toThrow(/target/);
});

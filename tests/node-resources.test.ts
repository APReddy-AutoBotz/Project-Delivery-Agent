import { describe, it, expect, vi } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { nodeFixture } from "./fixtures/node-evidence.js";
import {
  hash,
  verifyEvidenceFiles,
  assertReleaseReady,
  customerTargets,
} from "../scripts/distribution/evidence.mjs";
import { nodeTargets } from "../scripts/distribution/node-components.mjs";
import {
  describeNodeResources,
  nodeResourceCode,
  nodeResourceArgs,
  parseNodeResourceJson,
  validateNodeResourcePolicy,
  captureNodeResources,
  validateNodeResourceEvidence,
  verifyNodeResourceReports,
} from "../scripts/distribution/node-resources.mjs";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const runId = "pdaa-distribution-1234567890-12345678";
const ids = [
  "punycode",
  "internal/freeze_intrinsics",
  "internal/fs/rimraf",
  "internal/fs/cp/cp",
  "internal/fs/cp/cp-sync",
  "internal/process/finalization",
  "internal/streams/fast-utf8-stream",
].sort();
const descriptor = { enumerable: true, configurable: true, writable: true };
function fixture(target = "api", scope = "squashed") {
  const f = nodeFixture(target, scope);
  const snapshot = {
    schemaVersion: 1,
    version: f.policy.metadata.version,
    arch: f.policy.metadata.arch,
    platform: f.policy.metadata.platform,
    execPath: f.policy.metadata.execPath,
    entries: [
      { id: "configs", kind: "undefined", descriptor },
      ...ids.map((id) => ({
        id,
        kind: "utf8",
        descriptor,
        size: Buffer.byteLength(id),
        sha256: hash(id),
      })),
    ],
  };
  const policy = {
    schemaVersion: 1,
    reviewRequired: true,
    binary: f.policy.binary,
    rootNoticeSha256: f.policy.notice.sha256,
    sourceCommit: f.policy.source.commit,
    snapshot,
  };
  return {
    ...f,
    nodePolicyBytes: json(f.policy),
    resourcePolicy: policy,
    policyBytes: json(policy),
    resourceBytes: json(snapshot),
  };
}
type Fixture = ReturnType<typeof fixture>;
function capture(
  f: Fixture,
  execute = vi.fn(() => ({
    status: 0,
    stdout: f.resourceBytes,
    stderr: Buffer.alloc(0),
  })),
) {
  return captureNodeResources({ ...f, runId, env: {}, execute });
}
const run = (f: Fixture, receipt = capture(f).receipt) =>
  validateNodeResourceEvidence({ ...f, runId, receipt });

describe("own native resource discovery", () => {
  it("rejects lossy surrogate encoding before hashing", () => {
    const digest = vi.fn(hash);
    expect(() => describeNodeResources({ source: "\ud800" }, digest)).toThrow();
    expect(() => describeNodeResources({ source: "\udc00" }, digest)).toThrow();
    expect(digest).not.toHaveBeenCalled();
    expect(describeNodeResources({ source: "\ufffd" }, hash)[0].sha256).toBe(
      hash("\ufffd"),
    );
  });
  it("enumerates non-enumerable own data without evaluating source bodies or inherited entries", () => {
    const native = Object.create({ inherited: "ignored" });
    Object.defineProperty(native, "hidden", {
      value: "throw new Error('never evaluated')",
      writable: false,
      enumerable: false,
      configurable: false,
    });
    native.configs = undefined;
    const result = describeNodeResources(native, hash);
    expect(result.map((r: any) => r.id)).toEqual(["configs", "hidden"]);
    expect(result[1]).toEqual({
      id: "hidden",
      kind: "utf8",
      descriptor: { enumerable: false, configurable: false, writable: false },
      size: 34,
      sha256: hash("throw new Error('never evaluated')"),
    });
  });
  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "source"),
      native = {};
    Object.defineProperty(native, "danger", { get: getter });
    expect(() => describeNodeResources(native, hash)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    { [Symbol("hidden")]: "source" },
    { configs: null },
    { configs: 3 },
    { configs: () => "source" },
    { other: undefined },
    { "../bad": "source" },
    { "bad//name": "source" },
    { "": "source" },
    { empty: "" },
    {},
    [],
  ])("rejects unexpected own key/type shape %#", (native) =>
    expect(() => describeNodeResources(native, hash)).toThrow(),
  );
  it("bounds key count before reading descriptors", () => {
    expect(() =>
      describeNodeResources(
        Object.fromEntries(
          Array.from({ length: 1025 }, (_, n) => ["r" + n, "x"]),
        ),
        hash,
      ),
    ).toThrow();
  });
  it("bounds individual and aggregate bytes before hashing the excess value", () => {
    const digest = vi.fn(hash);
    expect(() =>
      describeNodeResources({ large: "x".repeat(8 * 1024 * 1024 + 1) }, digest),
    ).toThrow();
    expect(digest).not.toHaveBeenCalled();
    const block = "x".repeat(8 * 1024 * 1024);
    expect(() =>
      describeNodeResources({ a: block, b: block, c: "x" }, digest),
    ).toThrow();
    expect(digest).toHaveBeenCalledTimes(2);
  });
  it("preserves distinct UTF-8 representations and newline bytes", () => {
    const values = { a: "é\n", b: "e\u0301\r\n" };
    const entries = describeNodeResources(values, hash);
    expect(entries.map((e: any) => e.size)).toEqual([3, 5]);
    expect(entries.map((e: any) => e.sha256)).toEqual(
      Object.values(values).map((v) => hash(Buffer.from(v))),
    );
    expect(entries[0].sha256).not.toBe(entries[1].sha256);
  });
  it("executes the exact serialized probe using only fixed crypto and native-table interfaces", () => {
    let stdout = "";
    const native = { configs: undefined, example: "globalThis.executed=true" };
    const sandbox: any = {
      Buffer,
      require: (name: string) => {
        expect(name).toBe("node:crypto");
        return { createHash };
      },
      process: {
        version: "v24.19.0",
        arch: "x64",
        platform: "linux",
        execPath: "/usr/local/bin/node",
        binding: (name: string) => {
          expect(name).toBe("natives");
          return native;
        },
        stdout: {
          write: (value: string) => {
            stdout += value;
          },
        },
      },
    };
    runInNewContext(nodeResourceCode, sandbox, { timeout: 1000 });
    expect(sandbox.executed).toBeUndefined();
    expect(JSON.parse(stdout).entries[1].sha256).toBe(hash(native.example));
  });
});

describe("resource policy and exact captures", () => {
  it.each(
    nodeTargets.flatMap((target: string) =>
      ["squashed", "all-layers"].map((scope) => [target, scope]),
    ),
  )("binds %s %s and derives every residual section", (target, scope) => {
    const f = fixture(target, scope),
      result = run(f);
    expect(result.residualSections).toHaveLength(24);
    expect(
      result.residualSections.filter((s: any) => s.resourceCandidates.length),
    ).toHaveLength(6);
    expect(
      result.residualSections.flatMap((s: any) => s.resourceCandidates),
    ).toHaveLength(7);
    expect(
      result.residualSections.every(
        (s: any) =>
          s.membership === "unresolved-source-only" && s.reviewRequired,
      ),
    ).toBe(true);
    expect(result.ncrypto.componentNotice).toBe("unresolved");
    expect(result.nonStringEntries).toEqual([
      { id: "configs", kind: "undefined", descriptor },
    ]);
    if (target === "operations")
      expect(result.binary.layerID).not.toBe(result.notice.layerID);
  });
  it.each([
    [
      "resource omission",
      (s: any) => {
        s.entries.pop();
      },
    ],
    [
      "extra resource",
      (s: any) => {
        s.entries.push({ ...s.entries[1], id: "zzz" });
      },
    ],
    [
      "different bytes",
      (s: any) => {
        s.entries[1].sha256 = "c".repeat(64);
      },
    ],
    [
      "different size",
      (s: any) => {
        s.entries[1].size++;
      },
    ],
    [
      "descriptor change",
      (s: any) => {
        s.entries[1].descriptor.writable = false;
      },
    ],
    [
      "duplicate",
      (s: any) => {
        s.entries.push(s.entries[0]);
      },
    ],
    [
      "order",
      (s: any) => {
        s.entries.reverse();
      },
    ],
    [
      "undefined omitted",
      (s: any) => {
        s.entries.shift();
      },
    ],
    [
      "undefined converted to empty source",
      (s: any) => {
        s.entries[0] = { ...s.entries[1], id: "configs", size: 0 };
      },
    ],
    [
      "runtime identity",
      (s: any) => {
        s.version = "v24.19.1";
      },
    ],
    [
      "claimed execution",
      (s: any) => {
        s.entries[1].executed = true;
      },
    ],
  ] as const)(
    "rejects raw %s with a coherently rehashed receipt",
    (_name, mutate) => {
      const f = fixture(),
        receipt = capture(f).receipt,
        snapshot = JSON.parse(f.resourceBytes.toString());
      mutate(snapshot);
      f.resourceBytes = json(snapshot);
      receipt.stdout = {
        ...receipt.stdout,
        size: f.resourceBytes.length,
        sha256: hash(f.resourceBytes),
      };
      expect(() => run(f, receipt)).toThrow();
    },
  );
  it.each([
    Buffer.from([255]),
    Buffer.from('{"a":1,"a":1}'),
    Buffer.from('{"a":1e0}'),
    Buffer.alloc(256 * 1024 + 1),
    Buffer.from('{"a":"\u0000"}'),
  ])("rejects malformed/ambiguous JSON %#", (bytes) =>
    expect(() => parseNodeResourceJson(bytes)).toThrow(),
  );
  it("permits only syntax whitespace differences in reviewed policy JSON", () => {
    const f = fixture(),
      text = JSON.stringify(f.resourcePolicy, null, 2) + "\n";
    expect(
      validateNodeResourcePolicy(
        Buffer.from(text.replaceAll("\n", "\r\n")),
        f.nodePolicyBytes,
      ).policy,
    ).toEqual(f.resourcePolicy);
    expect(() =>
      validateNodeResourcePolicy(
        Buffer.from(
          text.replace(
            '"schemaVersion": 1,',
            '"schemaVersion": 1,"schemaVersion": 1,',
          ),
        ),
        f.nodePolicyBytes,
      ),
    ).toThrow(/duplicate/);
  });
  it("rejects weakened isolation and cross-target receipts", () => {
    const f = fixture();
    for (const mutate of [
      (r: any) => {
        r.target = "worker";
      },
      (r: any) => {
        r.command.args[r.command.args.indexOf("--network") + 1] = "host";
      },
      (r: any) => {
        r.runId += "0";
      },
      (r: any) => {
        r.stdout.file = "other.json";
      },
      (r: any) => {
        r.exitCode = 1;
      },
    ]) {
      const receipt = capture(f).receipt;
      mutate(receipt);
      expect(() => run(f, receipt)).toThrow(/receipt/);
    }
  });
});

describe("bounded isolated resource capture", () => {
  it("validates the image first and captures only the fixed bounded invocation", () => {
    const f = fixture(),
      execute = vi.fn(() => ({
        status: 0,
        stdout: f.resourceBytes,
        stderr: Buffer.alloc(0),
      }));
    const result = capture(f, execute);
    expect(result.resourceBytes).toEqual(f.resourceBytes);
    expect(execute).toHaveBeenCalledWith(
      "docker",
      nodeResourceArgs(f.target, f.inspection.Id, runId),
      { env: {}, timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true },
    );
    f.binary.digests[0]!.value = "c".repeat(64);
    execute.mockClear();
    expect(() => capture(f, execute)).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { error: new Error("timeout"), status: null },
    { status: 1 },
    { status: 0, stderr: Buffer.from("warning") },
  ])("cleans up only its named probe on command failure %#", (failure) => {
    const f = fixture(),
      execute: any = vi.fn(() => failure);
    expect(() => capture(f, execute)).toThrow(/probe failed/);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][1]).toEqual([
      "rm",
      "-f",
      `${runId}-resources-api`,
    ]);
  });
});

function archive(
  check: (
    directory: string,
    report: any,
    rewrite: (name: string, value: any) => void,
    trusted: any,
  ) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-resources-")),
    files: Record<string, string> = {},
    images: any = {};
  const rewrite = (name: string, value: any) => {
    const bytes = Buffer.isBuffer(value) ? value : json(value);
    writeFileSync(join(directory, name), bytes);
    files[name] = hash(bytes);
  };
  try {
    const f = fixture(),
      trusted = {
        trustedPolicyBytes: f.policyBytes,
        trustedNodePolicyBytes: f.nodePolicyBytes,
      };
    rewrite("node-resources.json", f.policyBytes);
    rewrite("node-components.json", f.nodePolicyBytes);
    for (const name of [
      "runtime-policy.json",
      "node-supplemental.json",
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
    for (const target of customerTargets) {
      const hasNode = nodeTargets.includes(target);
      for (const [suffix, scope] of [
        ["", "squashed"],
        [".layers", "all-layers"],
      ]) {
        const scoped = fixture(hasNode ? target : "api", scope);
        if (!hasNode) {
          scoped.inspection.Id = "sha256:" + hash(target);
          scoped.sbom.files = [];
        }
        const review: any = {
          imageId: scoped.inspection.Id,
          scope,
          ...(hasNode ? { nodeResources: run(scoped) } : {}),
        };
        if (!suffix) {
          images[target] = review;
          rewrite(`${target}.image.json`, scoped.inspection);
        } else images[target].allLayers = review;
        rewrite(`${target}${suffix}.syft.json`, scoped.sbom);
        for (const ext of ["spdx", "grype", "notices"])
          rewrite(`${target}${suffix}.${ext}.json`, {});
        if (hasNode) {
          rewrite(`${target}.node-resources.json`, scoped.resourceBytes);
          rewrite(`${target}.resource-receipt.json`, capture(scoped).receipt);
          rewrite(`${target}.node-metadata.json`, {});
          rewrite(`${target}.node-receipt.json`, {});
        }
      }
      rewrite(`${target}.review.json`, images[target]);
      rewrite(`${target}.layers.review.json`, images[target].allLayers);
    }
    check(
      directory,
      { schemaVersion: 7, status: "complete", runId, images, files },
      rewrite,
      trusted,
    );
  } finally {
    for (const name of readdirSync(directory))
      unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
}
describe("retained resource evidence and independent trust", () => {
  it("requires all 80 files, replays six scopes and rejects the prior schema", () =>
    archive((directory, report, _rewrite, trusted) => {
      expect(Object.keys(report.files)).toHaveLength(80);
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() =>
        verifyNodeResourceReports(directory, report, trusted),
      ).not.toThrow();
      expect(() =>
        verifyEvidenceFiles(directory, { ...report, schemaVersion: 6 }),
      ).toThrow(/schema/);
      expect(() =>
        assertReleaseReady({
          ...report,
          distributionAccepted: true,
          blockers: [],
        }),
      ).toThrow();
    }));
  it("rejects coherently substituted inventory, raw output, receipts and summaries against independent trusted pins", () =>
    archive((directory, report, rewrite, trusted) => {
      const policy = JSON.parse(
        readFileSync(join(directory, "node-resources.json"), "utf8"),
      );
      policy.snapshot.entries[1].sha256 = "c".repeat(64);
      rewrite("node-resources.json", policy);
      for (const target of nodeTargets) {
        const bytes = json(policy.snapshot),
          receipt = JSON.parse(
            readFileSync(
              join(directory, `${target}.resource-receipt.json`),
              "utf8",
            ),
          );
        rewrite(`${target}.node-resources.json`, bytes);
        receipt.stdout.size = bytes.length;
        receipt.stdout.sha256 = hash(bytes);
        receipt.policySha256 = hash(json(policy));
        rewrite(`${target}.resource-receipt.json`, receipt);
        for (const [suffix, scope] of [
          ["", "squashed"],
          [".layers", "all-layers"],
        ]) {
          const f = fixture(target, scope);
          f.policyBytes = json(policy);
          f.resourceBytes = bytes;
          const recorded = suffix
            ? report.images[target].allLayers
            : report.images[target];
          recorded.nodeResources = run(f, receipt);
          rewrite(`${target}${suffix}.review.json`, recorded);
        }
      }
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() =>
        verifyNodeResourceReports(directory, report, trusted),
      ).toThrow(/trusted checkout/);
    }));
  it.each([
    "residual omission",
    "invented membership",
    "ncrypto approval",
    "web summary",
  ])("rejects rehashed %s", (mode) =>
    archive((directory, report, rewrite, trusted) => {
      if (mode === "web summary") {
        report.images.web.nodeResources = report.images.api.nodeResources;
        rewrite("web.review.json", report.images.web);
      } else {
        const resource = report.images.api.nodeResources;
        if (mode === "residual omission") resource.residualSections.pop();
        if (mode === "invented membership")
          resource.residualSections[0].membership = "absent";
        if (mode === "ncrypto approval")
          resource.ncrypto.componentNotice = "approved";
        rewrite("api.review.json", report.images.api);
      }
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() =>
        verifyNodeResourceReports(directory, report, trusted),
      ).toThrow();
    }),
  );
  it("rejects an archived Node policy rewritten independently of its trusted source", () =>
    archive((directory, report, rewrite, trusted) => {
      const policy = JSON.parse(
        readFileSync(join(directory, "node-components.json"), "utf8"),
      );
      policy.source.files[1].sha256 = "d".repeat(64);
      rewrite("node-components.json", policy);
      expect(() =>
        verifyNodeResourceReports(directory, report, trusted),
      ).toThrow(/trusted checkout/);
    }));
  it("rejects a missing raw capture even if its manifest entry is deleted", () =>
    archive((directory, report) => {
      unlinkSync(join(directory, "operations.node-resources.json"));
      delete report.files["operations.node-resources.json"];
      expect(() => verifyEvidenceFiles(directory, report)).toThrow(
        /Required evidence/,
      );
    }));
});

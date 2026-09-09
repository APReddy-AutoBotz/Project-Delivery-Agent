import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeFixture } from "./fixtures/node-evidence.js";
import {
  hash,
  customerTargets,
  verifyEvidenceFiles,
  assertReleaseReady,
} from "../scripts/distribution/evidence.mjs";
import { nodeTargets } from "../scripts/distribution/node-components.mjs";
import {
  captureNodeResources,
  validateNodeResourceEvidence,
} from "../scripts/distribution/node-resources.mjs";
import { readBoundedNodeFile } from "../scripts/distribution/node-supplemental.mjs";
import {
  validateNodeSourcePolicy,
  createNodeSourceBundle,
  validateNodeSourceBundle,
  fetchNodeSourceBundle,
  validateNodeSourceEvidence,
  verifyNodeSourceReports,
  nodeSourceBundleLimit,
} from "../scripts/distribution/node-resource-sources.mjs";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const bundleJson = (value: unknown) =>
  Buffer.from(JSON.stringify(value) + "\n");
const runId = "pdaa-distribution-1234567890-12345678";
const reviewed = JSON.parse(
  readFileSync("scripts/distribution/node-resource-sources.json", "utf8"),
);
const descriptor = { writable: true, enumerable: true, configurable: true };
const blobHash = (bytes: Buffer) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
function fixture(target = "api", scope = "squashed") {
  const f = nodeFixture(target, scope);
  const originals = new Map<string, Buffer>();
  const sourcePolicy = structuredClone(reviewed);
  sourcePolicy.binary = f.policy.binary;
  sourcePolicy.rootNoticeSha256 = f.policy.notice.sha256;
  for (const source of sourcePolicy.sources) {
    const bytes = Buffer.from(
      `// Synthetic © ${source.resourceId}\r\nthrow new Error('never execute');\n`,
    );
    originals.set(source.path, bytes);
    Object.assign(source, {
      size: bytes.length,
      sha256: hash(bytes),
      gitBlobSha1: blobHash(bytes),
    });
  }
  const resourcePolicy = {
    schemaVersion: 1,
    reviewRequired: true,
    binary: f.policy.binary,
    rootNoticeSha256: f.policy.notice.sha256,
    sourceCommit: f.policy.source.commit,
    snapshot: {
      schemaVersion: 1,
      version: f.policy.metadata.version,
      arch: f.policy.metadata.arch,
      platform: f.policy.metadata.platform,
      execPath: f.policy.metadata.execPath,
      entries: [
        { id: "configs", kind: "undefined", descriptor },
        ...sourcePolicy.sources.map((source: any) => ({
          id: source.resourceId,
          kind: "utf8",
          descriptor,
          size: source.size,
          sha256: source.sha256,
        })),
      ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
  };
  const inputs = {
    ...f,
    sourcePolicy,
    resourcePolicy,
    originals,
    runId,
    sourcePolicyBytes: json(sourcePolicy),
    resourcePolicyBytes: json(resourcePolicy),
    nodePolicyBytes: json(f.policy),
    resourceBytes: json(resourcePolicy.snapshot),
  };
  const { receipt } = captureNodeResources({
    ...inputs,
    policyBytes: inputs.resourcePolicyBytes,
    env: {},
    execute: () => ({
      status: 0,
      stdout: inputs.resourceBytes,
      stderr: Buffer.alloc(0),
    }),
  });
  const bundleBytes = createNodeSourceBundle({
    ...inputs,
    readSource: (source: any) => originals.get(source.path),
  });
  return { ...inputs, receipt, bundleBytes };
}
type Fixture = ReturnType<typeof fixture>;
const refreshPolicyBinding = (f: Fixture) => {
  f.sourcePolicyBytes = json(f.sourcePolicy);
  const bundle = JSON.parse(f.bundleBytes.toString());
  bundle.sourcePolicySha256 = hash(f.sourcePolicyBytes);
  f.bundleBytes = bundleJson(bundle);
};
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("selected original source policy and exact bytes", () => {
  it("validates independently reviewed pins without requiring network or research files", () => {
    const policy = validateNodeSourcePolicy(
      readFileSync("scripts/distribution/node-resource-sources.json"),
      readFileSync("scripts/distribution/node-resources.json"),
      readFileSync("scripts/distribution/node-components.json"),
    );
    expect(policy.sources).toHaveLength(7);
    expect(policy.sources.reduce((n: number, s: any) => n + s.size, 0)).toBe(
      78421,
    );
    expect(new Set(policy.sources.map((s: any) => s.section)).size).toBe(6);
  });
  it("retains exact originals including CRLF, Unicode and executable-looking text without evaluating it", () => {
    const f = fixture();
    expect(() => validateNodeSourceBundle(f)).not.toThrow();
    const bundle = JSON.parse(f.bundleBytes.toString());
    for (const file of bundle.files)
      expect(Buffer.from(file.content, "base64")).toEqual(
        f.originals.get(file.path),
      );
    expect(
      createNodeSourceBundle({
        ...f,
        readSource: (s: any) => f.originals.get(s.path),
      }),
    ).toEqual(f.bundleBytes);
  });
  for (const [label, mutate] of [
    ["omitted cp-sync", (p: any) => p.sources.splice(4, 1)],
    ["duplicate pair", (p: any) => (p.sources[4] = p.sources[3])],
    ["reordered pairs", (p: any) => p.sources.reverse()],
    ["extra pair", (p: any) => p.sources.push(p.sources[0])],
    ["wrong section", (p: any) => (p.sources[0].section = "ncrypto")],
    ["wrong resource", (p: any) => (p.sources[0].resourceId = "configs")],
    ["unsafe path", (p: any) => (p.sources[0].path = "../LICENSE")],
    ["alternate commit", (p: any) => (p.sourceCommit = "0".repeat(40))],
    [
      "changed binary",
      (p: any) => (p.binary = { ...p.binary, sha256: "0".repeat(64) }),
    ],
    ["changed root notice", (p: any) => (p.rootNoticeSha256 = "0".repeat(64))],
    ["invented approval", (p: any) => (p.reviewRequired = false)],
    ["extra claim", (p: any) => (p.sourceExecuted = true)],
    ["source size overflow", (p: any) => (p.sources[0].size = 131073)],
    ["source size mismatch", (p: any) => p.sources[0].size--],
    [
      "source hash mismatch",
      (p: any) => (p.sources[0].sha256 = "0".repeat(64)),
    ],
    ["wrong Git blob", (p: any) => (p.sources[0].gitBlobSha1 = "0".repeat(40))],
  ] as const)
    it(`rejects ${label} even with a refreshed bundle policy hash`, () => {
      const f = fixture();
      mutate(f.sourcePolicy);
      refreshPolicyBinding(f);
      expect(() => validateNodeSourceBundle(f)).toThrow();
    });
  for (const [label, mutate] of [
    ["missing original", (b: any) => b.files.pop()],
    ["duplicate original", (b: any) => (b.files[1] = b.files[0])],
    ["reordered originals", (b: any) => b.files.reverse()],
    ["changed path", (b: any) => (b.files[0].path += ".copy")],
    ["wrong encoding", (b: any) => (b.files[0].encoding = "utf8")],
    ["extra field", (b: any) => (b.files[0].licenseApproved = true)],
    [
      "base64 whitespace",
      (b: any) => (b.files[0].content = " " + b.files[0].content.slice(1)),
    ],
    [
      "source byte alteration",
      (b: any) => {
        const v = Buffer.from(b.files[0].content, "base64");
        v[0] ^= 1;
        b.files[0].content = v.toString("base64");
      },
    ],
    [
      "line ending normalization",
      (b: any) =>
        (b.files[0].content = Buffer.from(
          Buffer.from(b.files[0].content, "base64")
            .toString()
            .replaceAll("\r\n", "\n"),
        ).toString("base64")),
    ],
    [
      "resource policy hash",
      (b: any) => (b.resourcePolicySha256 = "0".repeat(64)),
    ],
    ["Node policy hash", (b: any) => (b.nodePolicySha256 = "0".repeat(64))],
  ] as const)
    it(`rejects ${label} in retained original material`, () => {
      const f = fixture(),
        b = JSON.parse(f.bundleBytes.toString());
      mutate(b);
      f.bundleBytes = bundleJson(b);
      expect(() => validateNodeSourceBundle(f)).toThrow();
    });
  it("checks encoded and opened-file sizes before decoding or allocating source bytes", () => {
    const f = fixture(),
      b = JSON.parse(f.bundleBytes.toString());
    b.files[0].content = "A".repeat(10000);
    f.bundleBytes = bundleJson(b);
    expect(() => validateNodeSourceBundle(f)).toThrow(/before decode/);
    expect(() =>
      validateNodeSourceBundle({
        ...f,
        bundleBytes: Buffer.alloc(nodeSourceBundleLimit + 1),
      }),
    ).toThrow(/byte limit/);
    const directory = mkdtempSync(join(tmpdir(), "pdaa-source-size-")),
      path = join(directory, "source.js");
    try {
      writeFileSync(path, "too large");
      expect(() => readBoundedNodeFile(path, 100, 1)).toThrow(/before read/);
      expect(() => readBoundedNodeFile(directory, 100)).toThrow(/regular file/);
    } finally {
      unlinkSync(path);
      rmdirSync(directory);
    }
  });
  it("rejects invalid original UTF-8 even if both policies and Git/hash pins are coherently changed", () => {
    const f = fixture(),
      source = f.sourcePolicy.sources[0],
      bytes = Buffer.from([0xff]);
    Object.assign(source, {
      size: 1,
      sha256: hash(bytes),
      gitBlobSha1: blobHash(bytes),
    });
    const entry = f.resourcePolicy.snapshot.entries.find(
      (e: any) => e.id === source.resourceId,
    )!;
    Object.assign(entry, { size: 1, sha256: hash(bytes) });
    f.sourcePolicyBytes = json(f.sourcePolicy);
    f.resourcePolicyBytes = json(f.resourcePolicy);
    expect(() =>
      createNodeSourceBundle({ ...f, readSource: () => bytes }),
    ).toThrow(/UTF-8/);
  });
  it("rejects duplicate JSON keys and changes to canonical bundle formatting", () => {
    const f = fixture();
    expect(() =>
      validateNodeSourceBundle({
        ...f,
        bundleBytes: Buffer.from(
          f.bundleBytes
            .toString()
            .replace(
              '"schemaVersion":1',
              '"schemaVersion":1,"schemaVersion":1',
            ),
        ),
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      validateNodeSourceBundle({
        ...f,
        bundleBytes: Buffer.from(
          JSON.stringify(JSON.parse(f.bundleBytes.toString()), null, 2),
        ),
      }),
    ).toThrow(/canonical/);
  });
});

const response = (
  url: string,
  bytes: Buffer,
  headers?: Record<string, string>,
) => ({
  status: 200,
  url,
  headers: new Headers(headers),
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.enqueue(bytes.subarray(3));
      controller.close();
    },
  }),
});
describe("bounded source preparation", () => {
  it("fetches only the fixed seven immutable URLs serially and returns an offline-verifiable bundle", async () => {
    const f = fixture();
    const fetchSource = vi.fn(async (url: string, options: any) => {
      const source = f.sourcePolicy.sources[fetchSource.mock.calls.length - 1];
      expect(url).toBe(
        `https://raw.githubusercontent.com/nodejs/node/${f.sourcePolicy.sourceCommit}/${source.path}`,
      );
      expect(options.redirect).toBe("error");
      expect(options.headers["Accept-Encoding"]).toBe("identity");
      expect(options.signal.aborted).toBe(false);
      return response(url, f.originals.get(source.path)!, {
        "content-length": String(source.size),
      });
    });
    expect(await fetchNodeSourceBundle({ ...f, fetchSource })).toEqual(
      f.bundleBytes,
    );
    expect(fetchSource).toHaveBeenCalledTimes(7);
    expect(
      fetchSource.mock.calls.every(([, options]) => options.signal.aborted),
    ).toBe(true);
  });
  for (const [label, mutate] of [
    ["HTTP error", (r: any) => (r.status = 503)],
    ["different response URL", (r: any) => (r.url += "/other")],
    ["missing body", (r: any) => (r.body = null)],
    [
      "oversized declared body",
      (r: any) => r.headers.set("content-length", "999999"),
    ],
    [
      "ambiguous declared length",
      (r: any) => r.headers.set("content-length", "1e3"),
    ],
    [
      "oversized streamed body",
      (r: any) =>
        (r.body = new ReadableStream({
          start(c) {
            c.enqueue(Buffer.alloc(131073));
            c.close();
          },
        })),
    ],
    [
      "truncated body",
      (r: any) =>
        (r.body = new ReadableStream({
          start(c) {
            c.close();
          },
        })),
    ],
    [
      "body reader failure",
      (r: any) =>
        (r.body = new ReadableStream({
          start(c) {
            c.error(new Error("read failed"));
          },
        })),
    ],
  ] as const)
    it(`fails on ${label} without fetching the other originals`, async () => {
      const f = fixture(),
        first = f.sourcePolicy.sources[0];
      const fetchSource = vi.fn(async (url: string) => {
        const r = response(url, f.originals.get(first.path)!);
        mutate(r);
        return r;
      });
      await expect(
        fetchNodeSourceBundle({ ...f, fetchSource }),
      ).rejects.toThrow();
      expect(fetchSource).toHaveBeenCalledTimes(1);
    });
  for (const phase of ["headers", "body"])
    it(`enforces the complete response deadline during stalled ${phase}`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      let signal: AbortSignal;
      const fetchSource = vi.fn((url: string, options: any) => {
        signal = options.signal;
        return phase === "headers"
          ? new Promise(() => {})
          : Promise.resolve({
              status: 200,
              url,
              headers: new Headers(),
              body: new ReadableStream({ pull: () => new Promise(() => {}) }),
            });
      });
      const denial = expect(
        fetchNodeSourceBundle({ ...f, fetchSource }),
      ).rejects.toThrow(/deadline/);
      await vi.advanceTimersByTimeAsync(30000);
      await denial;
      expect(signal!.aborted).toBe(true);
      expect(fetchSource).toHaveBeenCalledTimes(1);
    });
  it("enforces one preparation deadline even when each earlier response completed within its own deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchSource = vi.fn(
      (url: string) =>
        new Promise((resolve) => {
          const source =
            f.sourcePolicy.sources[fetchSource.mock.calls.length - 1];
          setTimeout(
            () => resolve(response(url, f.originals.get(source.path)!)),
            25000,
          );
        }),
    );
    const denial = expect(
      fetchNodeSourceBundle({ ...f, fetchSource }),
    ).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(120000);
    await denial;
    expect(fetchSource).toHaveBeenCalledTimes(5);
  });
});

describe("physical source correspondence", () => {
  for (const target of nodeTargets)
    for (const scope of ["squashed", "all-layers"])
      it(`replays ${target}/${scope} while preserving all residual and ncrypto limits`, () => {
        const f = fixture(target, scope),
          result = validateNodeSourceEvidence(f);
        expect(result.selectedSources).toBe(7);
        expect(result.residualSections).toHaveLength(24);
        expect(
          result.residualSections.every(
            (s: any) => s.membership === "unresolved-source-only",
          ),
        ).toBe(true);
        expect(
          result.residualSections.filter(
            (s: any) => s.sourceCorrespondences.length,
          ),
        ).toHaveLength(6);
        expect(
          result.residualSections.flatMap((s: any) => s.sourceCorrespondences),
        ).toHaveLength(7);
        expect(result.ncrypto.componentNotice).toBe("unresolved");
        expect(result.imageId).toBe(f.inspection.Id);
        expect(result.scope).toBe(scope);
      });
  for (const [label, mutate] of [
    [
      "image substitution",
      (f: Fixture) => (f.inspection.Id = "sha256:" + "0".repeat(64)),
    ],
    ["missing physical notice", (f: Fixture) => f.sbom.files.splice(1, 1)],
    [
      "wrong binary digest",
      (f: Fixture) => (f.sbom.files[0]!.digests[0]!.value = "0".repeat(64)),
    ],
    [
      "wrong resource bytes",
      (f: Fixture) => (f.resourceBytes = Buffer.from("{}")),
    ],
    [
      "command substitution",
      (f: Fixture) =>
        (f.receipt.command.args[f.receipt.command.args.length - 1] = "0"),
    ],
  ] as const)
    it(`rejects ${label} before asserting source correspondence`, () => {
      const f = fixture();
      mutate(f);
      expect(() => validateNodeSourceEvidence(f)).toThrow();
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
  const directory = mkdtempSync(join(tmpdir(), "pdaa-source-archive-"));
  const files: Record<string, string> = {},
    images: any = {};
  const rewrite = (name: string, value: any) => {
    const bytes = Buffer.isBuffer(value) ? value : json(value);
    writeFileSync(join(directory, name), bytes);
    files[name] = hash(bytes);
  };
  try {
    const f = fixture();
    const trusted = {
      trustedSourcePolicyBytes: f.sourcePolicyBytes,
      trustedResourcePolicyBytes: f.resourcePolicyBytes,
      trustedNodePolicyBytes: f.nodePolicyBytes,
    };
    rewrite("node-components.json", f.nodePolicyBytes);
    rewrite("node-resources.json", f.resourcePolicyBytes);
    rewrite("node-resource-sources.json", f.sourcePolicyBytes);
    rewrite("node-source-bundle.json", f.bundleBytes);
    for (const name of [
      "runtime-policy.json",
      "gosu-disposition-policy.json",
      "gosu-static-analysis.json",
      "vulnerability-dispositions.json",
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
        const review: any = { imageId: scoped.inspection.Id, scope };
        if (hasNode) {
          review.nodeResources = validateNodeResourceEvidence({
            ...scoped,
            policyBytes: scoped.resourcePolicyBytes,
          });
          review.nodeResourceSources = validateNodeSourceEvidence(scoped);
          rewrite(`${target}.node-resources.json`, scoped.resourceBytes);
          rewrite(`${target}.resource-receipt.json`, scoped.receipt);
          rewrite(`${target}.node-metadata.json`, {});
          rewrite(`${target}.node-receipt.json`, {});
        }
        if (!suffix) {
          images[target] = review;
          rewrite(`${target}.image.json`, scoped.inspection);
        } else images[target].allLayers = review;
        rewrite(`${target}${suffix}.syft.json`, scoped.sbom);
        for (const ext of ["spdx", "grype", "notices"])
          rewrite(`${target}${suffix}.${ext}.json`, {});
      }
      rewrite(`${target}.review.json`, images[target]);
      rewrite(`${target}.layers.review.json`, images[target].allLayers);
    }
    check(
      directory,
      { schemaVersion: 9, status: "complete", runId, images, files },
      rewrite,
      trusted,
    );
  } finally {
    for (const name of readdirSync(directory))
      unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
}
describe("retained source bundle and independent policy authority", () => {
  it("replays all85files and six scopes while rejecting the previous schema and release approval", () =>
    archive((directory, report, _rewrite, trusted) => {
      expect(Object.keys(report.files)).toHaveLength(85);
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() =>
        verifyNodeSourceReports(directory, report, trusted),
      ).not.toThrow();
      expect(() =>
        verifyEvidenceFiles(directory, { ...report, schemaVersion: 8 }),
      ).toThrow(/schema/);
      expect(() =>
        assertReleaseReady({
          ...report,
          distributionAccepted: true,
          blockers: [],
        }),
      ).toThrow();
    }));
  it("accepts only policy syntax-whitespace differences in independently trusted inputs", () =>
    archive((directory, report, _rewrite, trusted) => {
      const spaced = Object.fromEntries(
        Object.entries(trusted).map(([key, bytes]: any) => [
          key,
          Buffer.from(
            JSON.stringify(JSON.parse(bytes), null, 2).replaceAll("\n", "\r\n"),
          ),
        ]),
      );
      expect(() =>
        verifyNodeSourceReports(directory, report, spaced),
      ).not.toThrow();
    }));
  for (const mutation of [
    "missing source",
    "forged summary",
    "extra target",
    "ncrypto approval",
    "missing residual",
  ])
    it(`rejects ${mutation} even after rewriting the outer manifest`, () =>
      archive((directory, report, rewrite, trusted) => {
        if (mutation === "missing source") {
          const b = JSON.parse(
            readFileSync(join(directory, "node-source-bundle.json"), "utf8"),
          );
          b.files.pop();
          rewrite("node-source-bundle.json", bundleJson(b));
        } else {
          if (mutation === "forged summary")
            report.images.api.nodeResourceSources.sourceBytes++;
          if (mutation === "extra target")
            report.images.web.nodeResourceSources =
              report.images.api.nodeResourceSources;
          if (mutation === "ncrypto approval")
            report.images.api.nodeResourceSources.ncrypto.componentNotice =
              "approved";
          if (mutation === "missing residual")
            report.images.api.nodeResourceSources.residualSections.pop();
          rewrite("api.review.json", report.images.api);
          rewrite("web.review.json", report.images.web);
        }
        expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
        expect(() =>
          verifyNodeSourceReports(directory, report, trusted),
        ).toThrow();
      }));
  it("rejects coherent source/resource policy, original-byte, receipt and summary rewrites against independent trusted inputs", () =>
    archive((directory, report, rewrite, trusted) => {
      const altered = fixture(),
        first = altered.sourcePolicy.sources[0],
        original = altered.originals.get(first.path)!;
      const bytes = Buffer.from(original);
      bytes[0] ^= 1;
      altered.originals.set(first.path, bytes);
      first.sha256 = hash(bytes);
      first.gitBlobSha1 = blobHash(bytes);
      altered.resourcePolicy.snapshot.entries.find(
        (e: any) => e.id === first.resourceId,
      )!.sha256 = hash(bytes);
      altered.sourcePolicyBytes = json(altered.sourcePolicy);
      altered.resourcePolicyBytes = json(altered.resourcePolicy);
      altered.resourceBytes = json(altered.resourcePolicy.snapshot);
      altered.bundleBytes = createNodeSourceBundle({
        ...altered,
        readSource: (s: any) => altered.originals.get(s.path),
      });
      rewrite("node-resource-sources.json", altered.sourcePolicyBytes);
      rewrite("node-resources.json", altered.resourcePolicyBytes);
      rewrite("node-source-bundle.json", altered.bundleBytes);
      for (const target of nodeTargets)
        for (const [scope, recorded] of [
          ["squashed", report.images[target]],
          ["all-layers", report.images[target].allLayers],
        ]) {
          const f = {
            ...fixture(target, scope),
            sourcePolicyBytes: altered.sourcePolicyBytes,
            resourcePolicyBytes: altered.resourcePolicyBytes,
            resourceBytes: altered.resourceBytes,
            bundleBytes: altered.bundleBytes,
          };
          f.receipt = captureNodeResources({
            ...f,
            policyBytes: f.resourcePolicyBytes,
            env: {},
            execute: () => ({
              status: 0,
              stdout: f.resourceBytes,
              stderr: Buffer.alloc(0),
            }),
          }).receipt;
          recorded.nodeResources = validateNodeResourceEvidence({
            ...f,
            policyBytes: f.resourcePolicyBytes,
          });
          recorded.nodeResourceSources = validateNodeSourceEvidence(f);
          rewrite(`${target}.node-resources.json`, f.resourceBytes);
          rewrite(`${target}.resource-receipt.json`, f.receipt);
        }
      for (const target of nodeTargets) {
        rewrite(`${target}.review.json`, report.images[target]);
        rewrite(
          `${target}.layers.review.json`,
          report.images[target].allLayers,
        );
      }
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() => verifyNodeSourceReports(directory, report, trusted)).toThrow(
        /trusted checkout/,
      );
    }));
});

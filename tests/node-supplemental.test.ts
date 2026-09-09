import { describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hash,
  verifyEvidenceFiles,
} from "../scripts/distribution/evidence.mjs";
import { nodeFixture } from "./fixtures/node-evidence.js";
import {
  nodeSupplementRoot,
  nodeSupplementIndex,
  validateNodeSupplementPolicy,
  sqliteAttributionSpans,
  materializeNodeSupplements,
  fetchNodeSupplementSources,
  validateNodeSupplementEvidence,
  verifyNodeSupplementReports,
  readBoundedNodeFile,
} from "../scripts/distribution/node-supplemental.mjs";

const committed = JSON.parse(
  readFileSync("scripts/distribution/node-supplemental.json", "utf8"),
);
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("bounded opened-file reads", () => {
  for (const mode of [
    "exact",
    "oversized",
    "wrong-pin",
    "directory",
    "invalid-bound",
  ]) {
    it(`handles ${mode} before unbounded allocation`, () => {
      const directory = mkdtempSync(join(tmpdir(), "pdaa-node-read-")),
        path = join(directory, "original");
      const bytes = Buffer.from("original fixture");
      writeFileSync(path, bytes);
      try {
        if (mode === "exact")
          expect(readBoundedNodeFile(path, 1024, bytes.length)).toEqual(bytes);
        else if (mode === "oversized")
          expect(() => readBoundedNodeFile(path, bytes.length - 1)).toThrow(
            /read bound/,
          );
        else if (mode === "wrong-pin")
          expect(() =>
            readBoundedNodeFile(path, 1024, bytes.length - 1),
          ).toThrow(/before read/);
        else if (mode === "directory")
          expect(() => readBoundedNodeFile(directory, 1024)).toThrow(
            /regular file/,
          );
        else
          expect(() =>
            readBoundedNodeFile(path, Number.MAX_SAFE_INTEGER),
          ).toThrow(/read bound/);
      } finally {
        unlinkSync(path);
        rmdirSync(directory);
      }
    });
  }
});
function fixture(target = "api", scope = "squashed") {
  const node = nodeFixture(target, scope),
    policy = structuredClone(committed);
  policy.binary = node.policy.binary;
  policy.rootNoticeSha256 = node.policy.notice.sha256;
  const sources = new Map<string, Buffer>();
  for (const parent of policy.source.files) {
    const count = parent.path.endsWith("sqlite3.c")
      ? 145
      : parent.path.endsWith("sqlite3.h")
        ? 3
        : 1;
    const bytes = parent.path.endsWith("LICENSE")
      ? Buffer.from("Complete original nbytes fixture © author.\n")
      : Buffer.from(
          'const char *sample="/* public domain */";\n// public domain\n' +
            Array.from(
              { length: count },
              (_, i) =>
                `/* The author disclaims copyright. Original © ${parent.path} ${i}. */\nint example_${i};\n`,
            ).join(""),
        );
    parent.size = bytes.length;
    parent.sha256 = hash(bytes);
    sources.set(parent.path, bytes);
  }
  for (const component of policy.components)
    component.notices = policy.source.files
      .filter((s: { path: string }) =>
        s.path.startsWith(component.sourcePath + "/"),
      )
      .flatMap((parent: { path: string; size: number; sha256: string }) => {
        const spans =
          component.key === "nbytes"
            ? [
                {
                  start: 0,
                  end: parent.size,
                  size: parent.size,
                  sha256: parent.sha256,
                },
              ]
            : sqliteAttributionSpans(sources.get(parent.path)!);
        return spans.map((span) => ({
          path:
            component.key === "nbytes"
              ? "nbytes/LICENSE"
              : `sqlite/${parent.path.split("/").at(-1)}/NOTICE-${span.start}-${span.end}.txt`,
          sourcePath: parent.path,
          ...span,
        }));
      });
  const nodePolicyBytes = jsonBytes(node.policy),
    policyBytes = jsonBytes(policy);
  const output = materializeNodeSupplements({
    policyBytes,
    nodePolicyBytes,
    sources,
    binaryBytes: node.binaryBytes,
    originalNoticeBytes: node.noticeBytes,
  });
  for (const [path, bytes] of output)
    node.sbom.files.push(
      node.file(nodeSupplementRoot + "/" + path, bytes, node.secondLayer),
    );
  return {
    ...node,
    policy,
    nodePolicy: node.policy,
    nodePolicyBytes,
    policyBytes,
    sources,
    output,
  };
}
type Fixture = ReturnType<typeof fixture>;
const run = (f: Fixture) =>
  validateNodeSupplementEvidence({
    target: f.target,
    inspection: f.inspection,
    sbom: f.sbom,
    policyBytes: jsonBytes(f.policy),
    nodePolicyBytes: jsonBytes(f.nodePolicy),
  });
const packageOutput = (f: Fixture) =>
  materializeNodeSupplements({
    policyBytes: jsonBytes(f.policy),
    nodePolicyBytes: jsonBytes(f.nodePolicy),
    sources: f.sources,
    binaryBytes: f.binaryBytes,
    originalNoticeBytes: f.noticeBytes,
  });
const selected = (f: Fixture) =>
  f.sbom.files.find((x) =>
    x.location.path.startsWith(nodeSupplementRoot + "/sqlite/"),
  )!;

describe("binary-bound original supplemental notices", () => {
  for (const target of ["api", "worker", "operations"])
    for (const scope of ["squashed", "all-layers"])
      it(`retains all150original occurrences and unresolved ncrypto in ${target} ${scope}`, () => {
        const f = fixture(target, scope),
          result = run(f);
        expect(
          result.components.map(
            (c: { notices: unknown[] }) => c.notices.length,
          ),
        ).toEqual([1, 149, 0]);
        expect(result.rootNoticeGaps).toEqual(["nbytes", "ncrypto", "sqlite"]);
        expect(result.supplementalCoverage).toEqual(["nbytes", "sqlite"]);
        expect(result.unresolvedSupplementalComponents).toEqual(["ncrypto"]);
        expect(result.index.layerID).not.toBe(result.binary.layerID);
        expect(result.reviewRequired).toBe(true);
        for (const c of result.components)
          for (const n of c.notices)
            expect(
              Buffer.from(
                f.sbom.files.find((x) => x.id === n.file.fileId)!.contents!,
                "base64",
              ),
            ).toEqual(f.sources.get(n.sourcePath)!.subarray(n.start, n.end));
      });
  const changes: [string, (f: Fixture) => void][] = [
    [
      "full source copied outside the namespace",
      (f) => {
        f.sbom.files.push(
          f.file(
            "/renamed-source.bin",
            f.sources.get("deps/sqlite/sqlite3.h")!,
          ),
        );
      },
    ],
    [
      "build-stage helper directory",
      (f) => {
        f.sbom.files.push(
          f.file(
            "/collector/scripts/package-node-notices.mjs",
            Buffer.from("helper"),
          ),
        );
      },
    ],
    [
      "missing notice",
      (f) => {
        f.sbom.files = f.sbom.files.filter((x) => x !== selected(f));
      },
    ],
    [
      "missing namespace",
      (f) => {
        f.sbom.files = f.sbom.files.filter(
          (x) => !x.location.path.startsWith(nodeSupplementRoot),
        );
      },
    ],
    [
      "missing index",
      (f) => {
        f.sbom.files = f.sbom.files.filter(
          (x) => x.location.path !== nodeSupplementIndex,
        );
      },
    ],
    [
      "changed captured text",
      (f) => {
        selected(f).contents = Buffer.from("substituted").toString("base64");
      },
    ],
    [
      "changed original digest",
      (f) => {
        selected(f).digests[0].value = "f".repeat(64);
      },
    ],
    [
      "normalized source extract",
      (f) => {
        const file = selected(f),
          bytes = Buffer.concat([
            Buffer.from(file.contents!, "base64"),
            Buffer.from("\n"),
          ]);
        file.contents = bytes.toString("base64");
        file.metadata.size = bytes.length;
        file.digests[0].value = hash(bytes);
      },
    ],
    [
      "noncanonical encoding",
      (f) => {
        selected(f).contents += "\n";
      },
    ],
    [
      "notice symlink",
      (f) => {
        selected(f).metadata.type = "SymbolicLink";
      },
    ],
    [
      "additional lower-layer copy",
      (f) => {
        const file = structuredClone(selected(f));
        file.id = "extra";
        file.location.layerID = f.layerID;
        f.sbom.files.push(file);
      },
    ],
    [
      "foreign supplying layer",
      (f) => {
        selected(f).location.layerID = "sha256:" + "c".repeat(64);
      },
    ],
    [
      "ambiguous file ID",
      (f) => {
        selected(f).id = f.binary.id;
      },
    ],
    [
      "extra namespace payload",
      (f) => {
        f.sbom.files.push(
          f.file(nodeSupplementRoot + "/foreign.txt", Buffer.from("foreign")),
        );
      },
    ],
    [
      "foreign namespace directory",
      (f) => {
        const file = f.file(nodeSupplementRoot + "/foreign", Buffer.from("x"));
        file.metadata.type = "Directory";
        f.sbom.files.push(file);
      },
    ],
    [
      "wrong accepted image",
      (f) => {
        f.inspection.Id = "sha256:" + "c".repeat(64);
      },
    ],
    [
      "changed Node executable",
      (f) => {
        f.binary.digests[0].value = "c".repeat(64);
      },
    ],
    [
      "policy substitution in index",
      (f) => {
        const file = f.sbom.files.find(
            (x) => x.location.path === nodeSupplementIndex,
          )!,
          index = JSON.parse(Buffer.from(file.contents!, "base64").toString());
        index.policySha256 = "a".repeat(64);
        const bytes = jsonBytes(index);
        file.contents = bytes.toString("base64");
        file.metadata.size = bytes.length;
        file.digests[0].value = hash(bytes);
      },
    ],
  ];
  for (const [name, mutate] of changes)
    it(`rejects ${name}`, () => {
      const f = fixture();
      mutate(f);
      expect(() => run(f)).toThrow();
    });
});

describe("reviewed parent-source and occurrence contract", () => {
  const changes: [string, (f: Fixture) => void][] = [
    [
      "waived review",
      (f) => {
        f.policy.reviewRequired = false;
      },
    ],
    [
      "different source commit",
      (f) => {
        f.policy.source.commit = "1".repeat(40);
      },
    ],
    [
      "floating source URL",
      (f) => {
        f.policy.source.files[0].url = f.policy.source.files[0].url.replace(
          f.policy.source.commit,
          "main",
        );
      },
    ],
    [
      "missing parent",
      (f) => {
        f.policy.source.files.pop();
      },
    ],
    [
      "omitted component",
      (f) => {
        f.policy.components.pop();
      },
    ],
    [
      "resolved ncrypto",
      (f) => {
        f.policy.components[2].method = "complete-original-file";
      },
    ],
    [
      "missing source occurrence",
      (f) => {
        f.policy.components[1].notices.pop();
      },
    ],
    [
      "duplicate source occurrence",
      (f) => {
        f.policy.components[1].notices[1] = structuredClone(
          f.policy.components[1].notices[0],
        );
      },
    ],
    [
      "changed component version",
      (f) => {
        f.policy.components[0].version = "9.9.9";
      },
    ],
    [
      "absolute output path",
      (f) => {
        f.policy.components[0].notices[0].path = "/tmp/LICENSE";
      },
    ],
    [
      "source namespace borrowing",
      (f) => {
        f.policy.components[0].notices[0].sourcePath = "deps/sqlite/sqlite3.h";
      },
    ],
    [
      "overlapping source range",
      (f) => {
        f.policy.components[1].notices[1].start = 0;
      },
    ],
    [
      "out-of-bounds source range",
      (f) => {
        f.policy.components[1].notices[0].end = 100000000;
      },
    ],
    [
      "partial original nbytes LICENSE",
      (f) => {
        f.policy.components[0].notices[0].start = 1;
        f.policy.components[0].notices[0].size--;
      },
    ],
    [
      "coherently emptied nbytes source root",
      (f) => {
        f.policy.components[0].sourcePath = "deps/other-nbytes";
        f.policy.components[0].notices = [];
        f.nodePolicy.components.find(
          (c: { key: string }) => c.key === "nbytes",
        ).sourcePath = "deps/other-nbytes";
      },
    ],
    [
      "coherently emptied SQLite source root",
      (f) => {
        f.policy.components[1].sourcePath = "deps/other-sqlite";
        f.policy.components[1].notices = [];
        f.nodePolicy.components.find(
          (c: { key: string }) => c.key === "sqlite",
        ).sourcePath = "deps/other-sqlite";
      },
    ],
  ];
  for (const [name, mutate] of changes)
    it(`rejects ${name}`, () => {
      const f = fixture();
      mutate(f);
      expect(() =>
        validateNodeSupplementPolicy(
          jsonBytes(f.policy),
          jsonBytes(f.nodePolicy),
        ),
      ).toThrow();
    });
  it("authenticates all full parents before returning the package index", () => {
    const f = fixture();
    f.sources.set("deps/sqlite/sqlite3.c", Buffer.from("altered parent"));
    expect(() => packageOutput(f)).toThrow(/source size|source SHA256/);
  });
  it("rejects additional parent sources", () => {
    const f = fixture();
    f.sources.set("deps/foreign", Buffer.from("x"));
    expect(() => packageOutput(f)).toThrow(/source set/);
  });
  it("rejects a different packaging binary", () => {
    const f = fixture();
    f.binaryBytes = Buffer.from("different");
    expect(() => packageOutput(f)).toThrow();
  });
  it("rejects an altered packaging root notice", () => {
    const f = fixture();
    f.noticeBytes = Buffer.from("different");
    expect(() => packageOutput(f)).toThrow(/root notice/);
  });
  it("rejects an extract digest substituted in the reviewed policy", () => {
    const f = fixture();
    f.policy.components[1].notices[0].sha256 = "d".repeat(64);
    expect(() => packageOutput(f)).toThrow(/comment coverage/);
  });
  it("rejects parent/index pins that select a marker inside a quoted C token", () => {
    const f = fixture(),
      parent = f.policy.source.files[1],
      original = f.sources.get(parent.path)!,
      notice = f.policy.components[1].notices[0];
    const changed = Buffer.concat([
      original.subarray(0, notice.start),
      Buffer.from('"'),
      original.subarray(notice.start, notice.end),
      Buffer.from('"'),
      original.subarray(notice.end),
    ]);
    f.sources.set(parent.path, changed);
    parent.size = changed.length;
    parent.sha256 = hash(changed);
    expect(() => packageOutput(f)).toThrow(/comment coverage/);
  });
});

describe("original C comment discovery", () => {
  it("ignores delimiters in strings, character literals and line comments", () => {
    const bytes = Buffer.from(
      "const char*s=\"/* public domain */\"; char q='/'; // /* public domain */\n/* The author disclaims copyright. © original. */",
    );
    const spans = sqliteAttributionSpans(bytes);
    expect(spans).toHaveLength(1);
    expect(bytes.subarray(spans[0].start, spans[0].end).toString()).toBe(
      "/* The author disclaims copyright. © original. */",
    );
  });
  it("preserves original offsets across logical character splices", () => {
    const bytes = Buffer.from(
      "// ignored \\\n/* public domain */\n/\\\r\n* public domain original *\\\n/",
    );
    const spans = sqliteAttributionSpans(bytes);
    expect(spans).toHaveLength(1);
    expect(bytes.subarray(spans[0].start, spans[0].end).toString()).toBe(
      "/\\\r\n* public domain original *\\\n/",
    );
  });
  it("retains repeated source occurrences but counts two markers in one comment once", () => {
    const bytes = Buffer.from(
      "/* public domain; The author disclaims copyright */\n/* public domain; The author disclaims copyright */",
    );
    const spans = sqliteAttributionSpans(bytes);
    expect(spans).toHaveLength(2);
    expect(spans[0].sha256).toBe(spans[1].sha256);
    expect(spans[0].start).not.toBe(spans[1].start);
  });
  it("rejects unterminated actual block comments", () =>
    expect(() =>
      sqliteAttributionSpans(Buffer.from("/* public domain")),
    ).toThrow(/Unterminated/));
});

describe("bounded original source fetching", () => {
  it("fetches only four fixed URLs without following redirects and verifies exact decoded bytes", async () => {
    const f = fixture(),
      fetcher = vi.fn(
        async (
          url: string,
          options: { redirect: string; signal: AbortSignal },
        ) => {
          expect(options.redirect).toBe("error");
          expect(options.signal.aborted).toBe(false);
          const parent = f.policy.source.files.find(
            (p: { url: string }) => p.url === url,
          );
          expect(parent).toBeDefined();
          return new Response(f.sources.get(parent.path)!);
        },
      );
    expect(
      await fetchNodeSupplementSources(
        f.policyBytes,
        f.nodePolicyBytes,
        fetcher,
      ),
    ).toEqual(f.sources);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every((c) => c[1].signal.aborted)).toBe(true);
  });
  for (const mode of ["status", "redirect", "oversized", "short", "checksum"])
    it(`rejects ${mode} responses before packaging`, async () => {
      const f = fixture(),
        original = f.sources.get("deps/nbytes/LICENSE")!;
      const fetcher = vi.fn(async () =>
        mode === "status"
          ? new Response("failure", { status: 404 })
          : mode === "redirect"
            ? new Response(null, { status: 302 })
            : new Response(
                mode === "oversized"
                  ? Buffer.concat([original, Buffer.from("extra")])
                  : mode === "short"
                    ? original.subarray(1)
                    : Buffer.alloc(original.length, 65),
              ),
      );
      await expect(
        fetchNodeSupplementSources(f.policyBytes, f.nodePolicyBytes, fetcher),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  it("aborts a stalled fetch after30seconds without retrying", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(),
        fetcher = vi.fn(
          (_url: string, options: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) =>
              options.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              ),
            ),
        );
      const assertion = expect(
        fetchNodeSupplementSources(f.policyBytes, f.nodePolicyBytes, fetcher),
      ).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function archive(
  check: (
    directory: string,
    report: any,
    rewrite: (name: string, value: unknown) => void,
  ) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-node-supplement-")),
    files: Record<string, string> = {},
    images: Record<string, any> = {};
  const rewrite = (name: string, value: unknown) => {
    const bytes = Buffer.isBuffer(value) ? value : jsonBytes(value);
    writeFileSync(join(directory, name), bytes);
    files[name] = hash(bytes);
  };
  try {
    const base = fixture();
    rewrite("node-components.json", base.nodePolicyBytes);
    rewrite("node-supplemental.json", base.policyBytes);
    rewrite("node-resources.json", {});
    rewrite("node-resource-sources.json", {});
    rewrite("node-source-bundle.json", {});
    rewrite("gosu-disposition-policy.json", {});
    rewrite("gosu-static-analysis.json", {});
    rewrite("perl-disposition-policy.json", {});
    rewrite("perl-static-analysis.json", {});
    rewrite("vulnerability-dispositions.json", {});
    for (const name of [
      "runtime-policy.json",
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
    for (const target of ["api", "worker", "web", "operations", "database"]) {
      for (const [suffix, scope] of [
        ["", "squashed"],
        [".layers", "all-layers"],
      ]) {
        const hasNode = ["api", "worker", "operations"].includes(target),
          f = hasNode ? fixture(target, scope) : fixture("api", scope);
        if (!hasNode) {
          f.inspection.Id = "sha256:" + hash(target);
          f.sbom.files = [];
        }
        const recorded: any = {
          imageId: f.inspection.Id,
          scope,
          ...(hasNode ? { nodeSupplements: run(f) } : {}),
        };
        if (!suffix) {
          images[target] = recorded;
          rewrite(`${target}.image.json`, f.inspection);
        } else images[target].allLayers = recorded;
        rewrite(`${target}${suffix}.syft.json`, f.sbom);
        for (const ext of ["spdx", "grype", "notices"])
          rewrite(`${target}${suffix}.${ext}.json`, {});
      }
      if (["api", "worker", "operations"].includes(target)) {
        rewrite(`${target}.node-metadata.json`, {});
        rewrite(`${target}.node-receipt.json`, {});
        rewrite(`${target}.node-resources.json`, {});
        rewrite(`${target}.resource-receipt.json`, {});
      }
    }
    for (const [target, entry] of Object.entries(images)) {
      rewrite(`${target}.review.json`, entry);
      rewrite(`${target}.layers.review.json`, entry.allLayers);
    }
    const report = {
      schemaVersion: 11,
      status: "complete",
      runId: "pdaa-distribution-1234567890-12345678",
      images,
      files,
    };
    check(directory, report, rewrite);
  } finally {
    for (const file of readdirSync(directory))
      unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
}
describe("retained source supplement replay", () => {
  it("rejects coherently emptied policies and index-only payload claiming coverage", () =>
    archive((directory, report, rewrite) => {
      const policy = JSON.parse(
        readFileSync(join(directory, "node-supplemental.json"), "utf8"),
      );
      const node = JSON.parse(
        readFileSync(join(directory, "node-components.json"), "utf8"),
      );
      for (const key of ["nbytes", "sqlite"]) {
        const component = policy.components.find(
          (c: { key: string }) => c.key === key,
        );
        component.sourcePath = `deps/other-${key}`;
        component.notices = [];
        node.components.find((c: { key: string }) => c.key === key).sourcePath =
          component.sourcePath;
      }
      rewrite("node-supplemental.json", policy);
      rewrite("node-components.json", node);
      const sbom = JSON.parse(
        readFileSync(join(directory, "api.syft.json"), "utf8"),
      );
      const indexFile = sbom.files.find(
        (f: { location: { path: string } }) =>
          f.location.path === nodeSupplementIndex,
      );
      const index = JSON.parse(
        Buffer.from(indexFile.contents, "base64").toString(),
      );
      index.components = policy.components;
      index.policySha256 = hash(jsonBytes(policy));
      index.nodePolicySha256 = hash(jsonBytes(node));
      const bytes = jsonBytes(index);
      indexFile.contents = bytes.toString("base64");
      indexFile.metadata.size = bytes.length;
      indexFile.digests[0].value = hash(bytes);
      sbom.files = sbom.files.filter(
        (f: { location: { path: string } }) =>
          !f.location.path.startsWith(nodeSupplementRoot) || f === indexFile,
      );
      rewrite("api.syft.json", sbom);
      report.images.api.nodeSupplements.components = policy.components;
      rewrite("api.review.json", report.images.api);
      verifyEvidenceFiles(directory, report);
      expect(() => verifyNodeSupplementReports(directory, report)).toThrow(
        /Reviewed supplemental source root/,
      );
    }));
  it("reconstructs every image scope from the complete73-file archive", () =>
    archive((directory, report) => {
      expect(Object.keys(report.files)).toHaveLength(87);
      expect(() => verifyEvidenceFiles(directory, report)).not.toThrow();
      expect(() =>
        verifyNodeSupplementReports(directory, report),
      ).not.toThrow();
    }));
  it("rejects a forged coverage claim even after rehashing its companion review", () =>
    archive((directory, report, rewrite) => {
      report.images.api.nodeSupplements.unresolvedSupplementalComponents = [];
      rewrite("api.review.json", report.images.api);
      verifyEvidenceFiles(directory, report);
      expect(() => verifyNodeSupplementReports(directory, report)).toThrow(
        /supplemental evidence/,
      );
    }));
  it("rejects coherent index/file removal in a lower-layer scope", () =>
    archive((directory, report, rewrite) => {
      const sbom = JSON.parse(
        readFileSync(join(directory, "worker.layers.syft.json"), "utf8"),
      );
      sbom.files = sbom.files.filter(
        (f: { location: { path: string } }) =>
          !f.location.path.startsWith(nodeSupplementRoot),
      );
      rewrite("worker.layers.syft.json", sbom);
      report.images.worker.allLayers.nodeSupplements.components = [];
      rewrite("worker.layers.review.json", report.images.worker.allLayers);
      rewrite("worker.review.json", report.images.worker);
      verifyEvidenceFiles(directory, report);
      expect(() => verifyNodeSupplementReports(directory, report)).toThrow();
    }));
  it("rejects missing supplement policy in old evidence", () =>
    archive((directory, report) => {
      delete report.files["node-supplemental.json"];
      unlinkSync(join(directory, "node-supplemental.json"));
      expect(() => verifyEvidenceFiles(directory, report)).toThrow(
        /Required evidence/,
      );
    }));
  it("rejects supplemental payload on a non-Node target", () =>
    archive((directory, report, rewrite) => {
      const sbom = JSON.parse(
        readFileSync(join(directory, "web.syft.json"), "utf8"),
      );
      sbom.files.push({ location: { path: nodeSupplementIndex } });
      rewrite("web.syft.json", sbom);
      verifyEvidenceFiles(directory, report);
      expect(() => verifyNodeSupplementReports(directory, report)).toThrow(
        /Unexpected supplemental payload/,
      );
    }));
});

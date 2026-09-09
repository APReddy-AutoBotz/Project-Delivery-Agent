// NFR-SEC-010 / AC-MNT-004: exact reviewed code absence, never scan suppression.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hash,
  validateImageReports,
  requireCompleteTargets,
} from "./evidence.mjs";
import { readBoundedNodeFile } from "./node-supplemental.mjs";
import { parseNodeResourceJson } from "./node-resources.mjs";

export const gosuEvidenceNames = [
  "gosu-disposition-policy.json",
  "gosu-static-analysis.json",
  "vulnerability-dispositions.json",
];
const maximum = 64 * 1024;
const parse = (bytes) => parseNodeResourceJson(bytes, maximum);
const trusted = (name) =>
  readBoundedNodeFile(new URL(name, import.meta.url), maximum);

export function validateGosuAnchors(
  policyBytes,
  analysisBytes,
  {
    trustedPolicyBytes = trusted("./gosu-disposition-policy.json"),
    trustedAnalysisBytes = trusted("./gosu-static-analysis.json"),
  } = {},
) {
  const policy = parse(policyBytes),
    analysis = parse(analysisBytes);
  assert.deepEqual(
    policy,
    parse(trustedPolicyBytes),
    "Gosu policy differs from trusted checkout",
  );
  assert.deepEqual(
    analysis,
    parse(trustedAnalysisBytes),
    "Gosu analysis differs from trusted checkout",
  );
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.ruleId, "gosu-go-2026-4337-code-absent-v1");
  assert.deepEqual(policy.targets, ["database", "operations"]);
  assert.deepEqual(policy.scopes, ["squashed", "all-layers"]);
  assert.equal(policy.disposition, "not_applicable");
  assert.equal(policy.advisory.id, "GO-2026-4337");
  assert.equal(policy.advisory.namespace, "govulndb:language:go");
  assert.equal(analysis.subjectSha256, policy.binary.sha256);
  assert.equal(analysis.subjectSize, policy.binary.size);
  assert.equal(analysis.goVersion, policy.binary.goVersion);
  assert.equal(analysis.module, policy.binary.mainModule);
  assert.equal(analysis.version, policy.binary.moduleVersion);
  assert.equal(analysis.subjectExecuted, false);
  assert.equal(analysis.functions, 2020);
  assert.equal(analysis.functionNames, 3019);
  assert.equal(analysis.files, 271);
  assert.deepEqual(analysis.positiveControls, ["main.main", "main.SetupUser"]);
  for (const key of ["cryptoTlsFunctions", "cryptoTlsNames", "cryptoTlsFiles"])
    assert.deepEqual(analysis[key], [], "TLS code absence is not established");
  return policy;
}

// Caller must first validate the complete native reports using validateImageReports.
// Keep raw matches untouched; record every selected occurrence, including duplicates.
export function deriveGosuDispositions({
  target,
  inspection,
  sbom,
  scan,
  policyBytes,
  analysisBytes,
}) {
  const policy = validateGosuAnchors(policyBytes, analysisBytes);
  const scope = sbom.descriptor?.configuration?.search?.scope;
  assert(policy.scopes.includes(scope), "Invalid disposition scope");
  if (!policy.targets.includes(target)) return [];
  const result = [];
  for (const [matchIndex, match] of scan.matches.entries()) {
    const advisory = match.vulnerability;
    if (
      advisory.id !== policy.advisory.id ||
      advisory.namespace !== policy.advisory.namespace ||
      !match.artifact.locations?.some((l) => l.path === policy.binary.path)
    )
      continue;
    for (const key of Object.keys(policy.advisory))
      assert.deepEqual(
        advisory[key],
        policy.advisory[key],
        "Selected advisory semantics changed; review required",
      );
    const packages = sbom.artifacts.filter((p) => p.id === match.artifact.id);
    assert.equal(packages.length, 1, "Ambiguous selected package identity");
    const p = packages[0];
    for (const [key, value] of Object.entries({
      name: "stdlib",
      version: policy.binary.goVersion,
      type: "go-module",
      language: "go",
      purl: "pkg:golang/stdlib@1.24.6",
    })) {
      assert.equal(p[key], value, "Selected SBOM package differs");
      assert.equal(match.artifact[key], value, "Selected scan package differs");
    }
    assert.equal(p.foundBy, "go-module-binary-cataloger");
    assert.equal(p.metadataType, "go-module-buildinfo-entry");
    assert.equal(p.metadata?.goCompiledVersion, policy.binary.goVersion);
    assert.equal(
      match.artifact.metadata?.goCompiledVersion,
      policy.binary.goVersion,
    );
    assert.deepEqual(
      match.artifact.locations,
      p.locations,
      "Scan package locations differ",
    );
    assert.equal(p.locations.length, 1, "Ambiguous selected package locations");
    const location = p.locations[0];
    assert.equal(location.path, policy.binary.path);
    assert.equal(location.accessPath, policy.binary.path);
    assert(
      inspection.RootFS.Layers.includes(location.layerID),
      "Unknown gosu supplying layer",
    );
    const files = sbom.files.filter(
      (f) => f.location?.path === policy.binary.path,
    );
    assert.equal(files.length, 1, "Ambiguous/missing physical gosu file");
    const file = files[0];
    assert(
      typeof file.id === "string" && file.id.length > 0,
      "Missing physical file ID",
    );
    assert.equal(
      sbom.files.filter((f) => f.id === file.id).length,
      1,
      "Duplicate physical file ID",
    );
    assert.equal(
      file.location.layerID,
      location.layerID,
      "Gosu file/package layer differs",
    );
    assert.equal(file.metadata?.type, "RegularFile");
    assert.equal(
      file.metadata.size,
      policy.binary.size,
      "Gosu byte size changed",
    );
    assert.deepEqual(
      file.digests?.filter((d) => d.algorithm === "sha256"),
      [{ algorithm: "sha256", value: policy.binary.sha256 }],
      "Gosu byte digest changed",
    );
    const mains = sbom.artifacts.filter(
      (a) =>
        a.name === policy.binary.mainModule &&
        a.locations?.some((l) => l.path === policy.binary.path),
    );
    assert.equal(mains.length, 1, "Gosu main module missing/ambiguous");
    assert.equal(mains[0].version, policy.binary.moduleVersion);
    for (const [key, value] of Object.entries({
      type: "go-module",
      language: "go",
      purl: "pkg:golang/github.com/tianon/gosu@v1.19.0",
      foundBy: "go-module-binary-cataloger",
      metadataType: "go-module-buildinfo-entry",
    }))
      assert.equal(mains[0][key], value, "Gosu main module identity differs");
    assert.equal(mains[0].metadata?.goCompiledVersion, policy.binary.goVersion);
    assert.deepEqual(
      mains[0].locations,
      p.locations,
      "Gosu main module location differs",
    );
    assert(
      Array.isArray(sbom.artifactRelationships),
      "Gosu relationships missing",
    );
    for (const pkg of [p, mains[0]])
      assert.deepEqual(
        sbom.artifactRelationships.filter(
          (r) => r.parent === pkg.id && r.type === "evident-by",
        ),
        [
          {
            parent: pkg.id,
            child: file.id,
            type: "evident-by",
            metadata: { kind: "primary" },
          },
        ],
        "Gosu primary file relationship differs",
      );
    assert.deepEqual(
      sbom.artifactRelationships.filter(
        (r) => r.parent === p.id && r.type === "dependency-of",
      ),
      [{ parent: p.id, child: mains[0].id, type: "dependency-of" }],
      "Gosu standard library dependency relationship differs",
    );
    result.push({
      ruleId: policy.ruleId,
      target,
      scope,
      imageId: inspection.Id,
      imageConfigId: sbom.source.metadata.imageID,
      matchIndex,
      matchSha256: hash(JSON.stringify(match)),
      advisoryId: advisory.id,
      namespace: advisory.namespace,
      packageId: p.id,
      purl: p.purl,
      version: p.version,
      location,
      fileId: file.id,
      binarySha256: policy.binary.sha256,
      binarySize: policy.binary.size,
      disposition: policy.disposition,
      reason: policy.reason,
    });
  }
  return result;
}

export function buildGosuDispositionReport(directory, report) {
  const pins = parse(trusted("./tools.json"));
  assert.deepEqual(
    report.tools,
    pins,
    "Scanner pins differ from trusted checkout",
  );
  requireCompleteTargets(report.images);
  assert(
    /^pdaa-distribution-\d+-[a-f0-9]{8}$/.test(report.runId),
    "Invalid disposition run",
  );
  const policyBytes = readBoundedNodeFile(
    join(directory, gosuEvidenceNames[0]),
    maximum,
  );
  const analysisBytes = readBoundedNodeFile(
    join(directory, gosuEvidenceNames[1]),
    maximum,
  );
  validateGosuAnchors(policyBytes, analysisBytes);
  const readBytes = (name) => readFileSync(join(directory, name));
  const read = (name) => JSON.parse(readBytes(name).toString("utf8"));
  const inputs = [],
    dispositions = [];
  for (const target of ["database", "operations"])
    for (const [suffix, scope] of [
      ["", "squashed"],
      [".layers", "all-layers"],
    ]) {
      const stem = target + suffix,
        inspection = read(`${target}.image.json`);
      const sbomBytes = readBytes(`${stem}.syft.json`),
        scanBytes = readBytes(`${stem}.grype.json`);
      const sbom = JSON.parse(sbomBytes),
        scan = JSON.parse(scanBytes);
      const validated = validateImageReports({
        inspection,
        sbom,
        scan,
        spdx: read(`${stem}.spdx.json`),
        pins,
        scope,
      });
      const recorded = suffix
        ? report.images[target].allLayers
        : report.images[target];
      assert.equal(recorded.imageId, validated.imageId);
      assert.equal(recorded.imageConfigId, validated.imageConfigId);
      assert.equal(recorded.scope, scope);
      assert.deepEqual(
        recorded.findings,
        validated.findings,
        "Original findings changed",
      );
      assert.deepEqual(
        recorded.severityCounts,
        validated.severityCounts,
        "Original severity counts changed",
      );
      inputs.push({
        target,
        scope,
        imageId: inspection.Id,
        sbomSha256: hash(sbomBytes),
        scanSha256: hash(scanBytes),
      });
      dispositions.push(
        ...deriveGosuDispositions({
          target,
          inspection,
          sbom,
          scan,
          policyBytes,
          analysisBytes,
        }),
      );
    }
  return {
    schemaVersion: 1,
    runId: report.runId,
    sourceTree: report.sourceTree,
    policySha256: hash(policyBytes),
    analysisSha256: hash(analysisBytes),
    inputs,
    dispositions,
    releaseApproved: false,
    originalFindingsUnchanged: true,
  };
}

export function verifyGosuDispositionReport(directory, report) {
  const expected = buildGosuDispositionReport(directory, report);
  assert.deepEqual(
    parse(readBoundedNodeFile(join(directory, gosuEvidenceNames[2]), maximum)),
    expected,
    "Retained vulnerability dispositions differ",
  );
  assert.deepEqual(
    report.vulnerabilityDispositions,
    {
      file: gosuEvidenceNames[2],
      notApplicable: expected.dispositions.length,
      releaseApproved: false,
    },
    "Disposition summary differs",
  );
  assert.equal(report.distributionAccepted, false);
  assert(
    report.blockers?.some((b) => b.code === "vulnerability-dispositions"),
    "Vulnerability review blocker missing",
  );
  return expected;
}

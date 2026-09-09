// NFR-SEC-010 / AC-MNT-004: architecture proof for exact Debian package bytes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hash,
  requireCompleteTargets,
  validateImageReports,
} from "./evidence.mjs";
import { readBoundedNodeFile } from "./node-supplemental.mjs";
import { parseNodeResourceJson } from "./node-resources.mjs";

export const perlEvidenceNames = [
  "perl-disposition-policy.json",
  "perl-static-analysis.json",
];
export const perlAnchorLimit = 64 * 1024;
const parse = (bytes) => parseNodeResourceJson(bytes, perlAnchorLimit);
export const canonical = (value) => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  return value;
}
export function readPerlAnchor(name) {
  assert(perlEvidenceNames.includes(name), "Unknown Perl anchor");
  return readBoundedNodeFile(new URL(name, import.meta.url), perlAnchorLimit);
}
export function validatePerlAnchors(policyBytes, analysisBytes) {
  const policy = parse(policyBytes),
    analysis = parse(analysisBytes);
  assert.deepEqual(
    policy,
    parse(readPerlAnchor(perlEvidenceNames[0])),
    "Perl policy differs from trusted checkout",
  );
  assert.deepEqual(
    analysis,
    parse(readPerlAnchor(perlEvidenceNames[1])),
    "Perl analysis differs from trusted checkout",
  );
  assert.equal(policy.schemaVersion, 2);
  assert.equal(analysis.schemaVersion, 1);
  assert.equal(policy.analysisSha256, hash(canonical(analysis)));
  assert.equal(policy.rule.advisory.id, "CVE-2026-8376");
  assert.equal(policy.rule.advisory.namespace, "debian:distro:debian:12");
  assert.equal(policy.rule.disposition, "not_applicable");
  assert.equal(analysis.subjectExecuted, false);
  assert.equal(analysis.wholeImageAbsenceEstablished, false);
  assert.deepEqual(policy.targets, ["api", "worker", "database", "operations"]);
  assert.deepEqual(policy.scopes, ["squashed", "all-layers"]);
  assert.equal(policy.inputs.length, 8);
  assert.equal(
    new Set(policy.inputs.map((s) => `${s.target}/${s.scope}`)).size,
    8,
  );
  for (const pkg of analysis.packages) {
    assert.equal(pkg.version, "5.36.0-7+deb12u3");
    for (const member of pkg.material) {
      if (member.elf) {
        assert.equal(member.elf.class, 64);
        assert.equal(member.elf.machine, 62);
        assert.equal(member.elf.encoding, "little");
      }
      if (member.buildWidths) {
        for (const key of [
          "ptrsize",
          "ivsize",
          "uvsize",
          "sizesize",
          "longsize",
        ])
          assert.equal(member.buildWidths[key], "8");
        assert.equal(member.buildWidths.intsize, "4");
        assert.equal(member.buildWidths.ssizetype, "ssize_t");
      }
    }
  }
  return { policy, analysis };
}

// EPSS is daily prioritization metadata, not an applicability predicate. Only
// these reviewed description profiles and validated enrichment leaves vary in
// the comparison copy; the source scan and each row's full match hash stay raw.
export function capturePerlMatchEnvelope(match, rule) {
  const envelope = globalThis.structuredClone(
    Object.fromEntries(
      Object.entries(match).filter(
        ([key]) => !["artifact", "vulnerability"].includes(key),
      ),
    ),
  );
  assert(
    Array.isArray(envelope.relatedVulnerabilities) &&
      envelope.relatedVulnerabilities.length === 1,
  );
  const related = envelope.relatedVulnerabilities[0];
  for (const key of ["id", "namespace", "dataSource"])
    assert.equal(related[key], rule.relatedAdvisory[key]);
  assert.equal(typeof related.description, "string");
  assert(
    rule.relatedAdvisory.descriptionSha256.includes(hash(related.description)),
    "Unreviewed related Perl advisory description",
  );
  assert(Array.isArray(related.epss) && related.epss.length === 1);
  const epss = related.epss[0];
  assert.deepEqual(Object.keys(epss).sort(), [
    "cve",
    "date",
    "epss",
    "percentile",
  ]);
  assert.equal(epss.cve, rule.advisory.id);
  for (const key of ["epss", "percentile"])
    assert(
      typeof epss[key] === "number" &&
        Number.isFinite(epss[key]) &&
        epss[key] >= 0 &&
        epss[key] <= 1,
      "Invalid related Perl EPSS probability",
    );
  assert(
    typeof epss.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(epss.date),
  );
  const timestamp = Date.parse(epss.date + "T00:00:00Z");
  assert(
    Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === epss.date,
    "Invalid related Perl EPSS calendar date",
  );
  related.description = "reviewed-perl-description";
  epss.date = "validated-daily-date";
  epss.epss = "validated-probability";
  epss.percentile = "validated-percentile";
  return envelope;
}

// Pure capture supports independent replay/tests. Only derivePerlDispositions
// authorizes rows, after checking the independently trusted checkout anchors.
export function capturePerlScopeFacts({ inspection, sbom, analysis }) {
  const layers = inspection.RootFS.Layers;
  const packages = sbom.artifacts.filter(
    (p) => (p.metadata?.source || p.name) === "perl",
  );
  assert(packages.length > 0, "Missing Perl source packages");
  const ids = new Map();
  for (const f of sbom.files) {
    assert(f.id && !ids.has(f.id), "Missing/duplicate physical file ID");
    assert(layers.includes(f.location?.layerID), "Unknown physical file layer");
    ids.set(
      f.id,
      `file:${f.location.path}@${layers.indexOf(f.location.layerID)}`,
    );
  }
  for (const p of sbom.artifacts) {
    assert(p.id && !ids.has(p.id), "Missing/duplicate package ID");
    ids.set(p.id, `package:${p.name}:${p.purl}`);
  }
  if (sbom.source.id) ids.set(sbom.source.id, "image-source");
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        if (key === "layerID") {
          assert(layers.includes(v), "Unknown Perl supplying layer");
          return [key, layers.indexOf(v)];
        }
        if (
          ["id", "parent", "child"].includes(key) &&
          typeof v === "string" &&
          ids.has(v)
        )
          return [key, ids.get(v)];
        return [key, normalize(v)];
      }),
    );
  };
  const paths = new Set(),
    materialHashes = new Set(),
    selectedIds = new Set(packages.map((p) => p.id));
  for (const p of packages) {
    const original = analysis.packages.find((a) => a.name === p.name);
    assert(original, "Unreviewed Perl source package");
    assert.equal(p.type, "deb");
    assert.equal(p.version, original.version);
    assert.equal(p.metadata?.architecture, original.architecture);
    assert(
      Array.isArray(p.metadata.files),
      "Missing complete Perl ownership metadata",
    );
    assert.equal(
      new Set(p.metadata.files.map((f) => f.path)).size,
      p.metadata.files.length,
      "Duplicate Perl ownership path",
    );
    for (const f of p.metadata.files) paths.add(f.path);
    for (const loc of p.locations) paths.add(loc.path);
    for (const member of original.material) {
      paths.add(member.path);
      if (member.sha256) materialHashes.add(member.sha256);
      const files = sbom.files.filter((f) => f.location.path === member.path);
      assert(files.length > 0, "Missing material Perl file");
      for (const file of files) {
        if (member.type === "symlink") {
          assert.equal(file.metadata.type, "SymbolicLink");
          assert.equal(file.metadata.linkDestination, member.target);
        } else {
          assert.equal(file.metadata.type, "RegularFile");
          assert.equal(file.metadata.size, member.size);
          assert.deepEqual(
            file.digests?.filter((d) => d.algorithm === "sha256"),
            [{ algorithm: "sha256", value: member.sha256 }],
            "Perl material bytes changed",
          );
          assert.equal(
            sbom.artifactRelationships.filter(
              (r) =>
                r.parent === p.id &&
                r.child === file.id &&
                r.type === "contains",
            ).length,
            1,
            "Perl material ownership differs",
          );
          if (member.elf) {
            assert.equal(file.executable?.format, "elf");
            assert.deepEqual(
              [...file.executable.importedLibraries].sort(),
              member.elf.needed,
            );
          }
        }
      }
    }
  }
  const files = sbom.files.filter(
    (f) =>
      paths.has(f.location.path) ||
      f.digests?.some(
        (d) => d.algorithm === "sha256" && materialHashes.has(d.value),
      ) ||
      f.executable?.importedLibraries?.some((lib) => /perl/i.test(lib)) ||
      (f.metadata.type !== "Directory" &&
        /\/(?:perl(?:[0-9][0-9.\-a-z_]*)?|libperl[^/]*\.(?:so(?:\.[0-9.]+)?|a))$/.test(
          f.location.path,
        )),
  );
  const relationships = sbom.artifactRelationships.filter(
    (r) => selectedIds.has(r.parent) || selectedIds.has(r.child),
  );
  for (const r of relationships)
    assert(
      ids.has(r.parent) && ids.has(r.child),
      "Unknown Perl relationship endpoint",
    );
  const ordered = (values) =>
    values
      .map(normalize)
      .sort((a, b) =>
        canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0,
      );
  return {
    facts: {
      packages: ordered(packages),
      files: ordered(files),
      relationships: ordered(relationships),
    },
    packages,
    normalize,
  };
}

export function derivePerlDispositions({
  target,
  inspection,
  sbom,
  scan,
  policyBytes,
  analysisBytes,
}) {
  const { policy, analysis } = validatePerlAnchors(policyBytes, analysisBytes);
  return deriveReviewedPerlRows({
    target,
    inspection,
    sbom,
    scan,
    policy,
    analysis,
  });
}

// Pure rule application; archive entrypoints always use derivePerlDispositions.
export function deriveReviewedPerlRows({
  target,
  inspection,
  sbom,
  scan,
  policy,
  analysis,
}) {
  const scope = sbom.descriptor?.configuration?.search?.scope;
  assert(policy.scopes.includes(scope), "Invalid Perl disposition scope");
  if (!policy.targets.includes(target)) return [];
  const expected = policy.inputs.find(
    (s) => s.target === target && s.scope === scope,
  );
  assert(expected, "Unreviewed Perl target/scope");
  const { facts, packages, normalize } = capturePerlScopeFacts({
    inspection,
    sbom,
    analysis,
  });
  assert.deepEqual(
    packages.map((p) => p.name).sort(),
    expected.packageNames,
    "Perl package set changed",
  );
  assert.equal(
    facts.files.length,
    expected.fileCount,
    "Perl physical coverage changed",
  );
  assert.equal(
    hash(canonical(facts)),
    expected.factsSha256,
    "Complete Perl package/file/layer/relationship evidence changed",
  );
  const result = [],
    rule = policy.rule;
  for (const [matchIndex, match] of scan.matches.entries()) {
    if (
      match.vulnerability.id !== rule.advisory.id ||
      match.vulnerability.namespace !== rule.advisory.namespace
    )
      continue;
    const pkg = packages.find((p) => p.id === match.artifact.id);
    if (!pkg) continue;
    for (const [key, value] of Object.entries(rule.advisory))
      assert.deepEqual(
        match.vulnerability[key],
        value,
        "Selected Perl advisory semantics changed; review required",
      );
    assert.equal(
      hash(canonical(normalize(match.artifact))),
      expected.matchArtifacts[pkg.name],
      "Selected Perl scan artifact changed",
    );
    const envelope = capturePerlMatchEnvelope(match, rule);
    assert.equal(
      hash(canonical(normalize(envelope))),
      expected.matchEnvelopes[pkg.name],
      "Selected Perl match envelope changed; review required",
    );
    result.push({
      ruleId: rule.ruleId,
      target,
      scope,
      imageId: inspection.Id,
      imageConfigId: sbom.source.metadata.imageID,
      matchIndex,
      matchSha256: hash(JSON.stringify(match)),
      advisoryId: rule.advisory.id,
      namespace: rule.advisory.namespace,
      packageId: pkg.id,
      purl: pkg.purl,
      version: pkg.version,
      locations: pkg.locations,
      scopeFactsSha256: expected.factsSha256,
      disposition: rule.disposition,
      reason: rule.reason,
    });
  }
  return result;
}

export function buildPerlDispositionReport(directory, report) {
  const pins = JSON.parse(
    readFileSync(new URL("./tools.json", import.meta.url)),
  );
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
  const [policyBytes, analysisBytes] = perlEvidenceNames.map((n) =>
    readBoundedNodeFile(join(directory, n), perlAnchorLimit),
  );
  const { policy } = validatePerlAnchors(policyBytes, analysisBytes);
  const readBytes = (name) => readFileSync(join(directory, name));
  const read = (name) => JSON.parse(readBytes(name));
  const inputs = [],
    dispositions = [];
  for (const target of policy.targets)
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
      for (const key of [
        "imageId",
        "imageConfigId",
        "scope",
        "findings",
        "severityCounts",
      ])
        assert.deepEqual(
          recorded[key],
          validated[key],
          "Original Perl image/findings summary changed",
        );
      inputs.push({
        target,
        scope,
        imageId: inspection.Id,
        sbomSha256: hash(sbomBytes),
        scanSha256: hash(scanBytes),
      });
      dispositions.push(
        ...derivePerlDispositions({
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

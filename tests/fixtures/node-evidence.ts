import { readFileSync } from "node:fs";
import { hash } from "../../scripts/distribution/evidence.mjs";
const committedPolicy = JSON.parse(
  readFileSync("scripts/distribution/node-components.json", "utf8"),
);
export function nodeFixture(target = "api", scope = "squashed") {
  const policy = structuredClone(committedPolicy);
  // Synthetic original text keeps real section names/paths but copies no source notice.
  const preamble = Buffer.from(
    "Node.js is licensed for use as follows:\nFixture © author.\n\n",
  );
  const parts = [preamble];
  policy.notice.preamble = {
    start: 0,
    end: preamble.length,
    sha256: hash(preamble),
  };
  let cursor = preamble.length;
  policy.notice.sections = policy.notice.sections.map(
    (s: { name: string; sourcePath: string }) => {
      const bytes = Buffer.from(
        `- ${s.name}, located at ${s.sourcePath}, is licensed as follows:\n\nFixture attribution © ${s.name}.\n\n`,
      );
      const section = {
        ...s,
        start: cursor,
        end: cursor + bytes.length,
        sha256: hash(bytes),
      };
      cursor += bytes.length;
      parts.push(bytes);
      return section;
    },
  );
  const noticeBytes = Buffer.concat(parts);
  policy.notice.size = noticeBytes.length;
  policy.notice.sha256 = hash(noticeBytes);
  const source = policy.source.files.find(
    (f: { path: string }) => f.path === "LICENSE",
  );
  source.size = noticeBytes.length;
  source.sha256 = hash(noticeBytes);
  const binaryBytes = Buffer.from("Synthetic Node executable fixture");
  policy.binary.size = binaryBytes.length;
  policy.binary.sha256 = hash(binaryBytes);
  const layerID = "sha256:" + "a".repeat(64),
    secondLayer = "sha256:" + "b".repeat(64);
  const file = (
    path: string,
    bytes: Buffer,
    layer = layerID,
    capture = true,
  ) => ({
    id: hash(path + layer),
    location: { path, layerID: layer },
    metadata: { type: "RegularFile", size: bytes.length },
    digests: [{ algorithm: "sha256", value: hash(bytes) }],
    ...(capture ? { contents: bytes.toString("base64") } : {}),
  });
  const binary = file(policy.binary.path, binaryBytes, layerID, false);
  const notice = file(
    policy.notice.paths[target],
    noticeBytes,
    target === "operations" ? secondLayer : layerID,
  );
  const configBytes = Buffer.from(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      rootfs: { diff_ids: [layerID, secondLayer] },
      config: { Labels: { target } },
    }),
  );
  const imageId = "sha256:" + hash(configBytes);
  const inspection = {
    Id: imageId,
    Os: "linux",
    Architecture: "amd64",
    RootFS: { Layers: [layerID, secondLayer] },
  };
  const sbom = {
    descriptor: { configuration: { search: { scope } } },
    source: {
      type: "image",
      metadata: {
        userInput: imageId,
        imageID: imageId,
        config: configBytes.toString("base64"),
      },
    },
    artifacts: [
      {
        id: "node-package",
        name: "node",
        version: policy.metadata.versions.node,
        type: "binary",
        licenses: [],
        locations: [{ path: policy.binary.path, layerID }],
      },
    ],
    files: [binary, notice],
  };
  const metadataBytes = Buffer.from(JSON.stringify(policy.metadata));
  return {
    target,
    scope,
    policy,
    noticeBytes,
    binaryBytes,
    file,
    binary,
    notice,
    inspection,
    sbom,
    metadataBytes,
    layerID,
    secondLayer,
  };
}

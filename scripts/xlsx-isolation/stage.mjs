import {
  copySources,
  parserFiles,
  stageParserDependencies,
} from "../xlsx-runtime/staging.mjs";

export { root } from "../xlsx-runtime/staging.mjs";

export function stage(destination) {
  const files = [
    ...parserFiles,
    ...[
      "boundary",
      "caller",
      "server",
      "service",
      "supervise",
      "wire",
      "worker",
    ].map((name) => `scripts/xlsx-isolation/${name}.mjs`),
    "tests/fixtures/xlsx-test-worksheet.ts",
    "tests/fixtures/xlsx-test-archive.ts",
    "deploy/xlsx-isolation/Dockerfile",
  ];
  stageParserDependencies(destination);
  copySources(destination, files);
}

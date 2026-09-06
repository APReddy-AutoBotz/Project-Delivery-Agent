// NFR-SEC-010: development-only, checksum-pinned publisher executables.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const toolPins = JSON.parse(
  readFileSync(new URL("./tools.json", import.meta.url), "utf8"),
);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function installTools(root) {
  assert(
    process.arch === "x64" && ["win32", "linux"].includes(process.platform),
    "Distribution tooling supports x64 Windows/Linux only",
  );
  const executables = {};
  for (const [tool, pin] of Object.entries(toolPins)) {
    const directory = resolve(
      root,
      "tmp/distribution-tools",
      tool,
      pin.version,
    );
    mkdirSync(directory, { recursive: true });
    const archive = join(
      directory,
      process.platform === "win32" ? "tool.zip" : "tool.tar.gz",
    );
    const platform =
      process.platform === "win32" ? "windows_amd64.zip" : "linux_amd64.tar.gz";
    const url = `${pin.repository}/releases/download/v${pin.version}/${tool}_${pin.version}_${platform}`;
    if (!existsSync(archive)) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(180000),
      });
      assert(response.ok, `${tool} publisher download failed`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(
        sha256(bytes),
        pin[process.platform],
        `${tool} archive checksum mismatch`,
      );
      writeFileSync(archive, bytes);
    }
    assert.equal(
      sha256(readFileSync(archive)),
      pin[process.platform],
      `${tool} cached archive checksum mismatch`,
    );
    const binary = tool + (process.platform === "win32" ? ".exe" : "");
    // Extract only these two known files; never execute a remote install script.
    const unpack = spawnSync(
      "tar",
      ["-xf", archive, "-C", directory, binary, "LICENSE"],
      { encoding: "utf8" },
    );
    assert.equal(unpack.status, 0, `${tool} extraction failed`);
    if (process.platform === "linux") chmodSync(join(directory, binary), 0o755);
    executables[tool] = join(directory, binary);
  }
  return executables;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await installTools(resolve(import.meta.dirname, "../.."));
  console.log(
    "Verified distribution tooling installed in the project's ignored tmp directory.",
  );
}

import { execFileSync } from "node:child_process";

const evidencePaths = new Set([
  "docs/04-delivery/IMPLEMENTATION_STATUS.md",
  "docs/05-quality/ATLAS_RELEASE_EVIDENCE.md",
  "requirements/traceability/stories.yaml",
  "requirements/traceability/tests.yaml",
]);
const sha = /^[0-9a-f]{40}$/u;
const regularEdit = /^:100644 100644 [0-9a-f]+ [0-9a-f]+ M$/u;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function classify(event, base, head) {
  if (event !== "pull_request" || !sha.test(base ?? "") || !sha.test(head ?? "")) return "full";
  try {
    if (git("rev-parse", "--verify", "HEAD^1").trim() !== base || git("rev-parse", "--verify", "HEAD^2").trim() !== head)
      return "full";
    const entries = git("diff", "--raw", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-z", base, "HEAD", "--").split("\0");
    if (entries.pop() !== "" || entries.length === 0 || entries.length % 2 !== 0) return "full";
    for (let index = 0; index < entries.length; index += 2) {
      if (!regularEdit.test(entries[index]) || !evidencePaths.has(entries[index + 1])) return "full";
    }
    return "evidence-only";
  } catch {
    return "full";
  }
}

process.stdout.write(classify(...process.argv.slice(2)) + "\n");

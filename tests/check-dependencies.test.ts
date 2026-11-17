import { describe, expect, it } from "vitest";
import { checkDependencies } from "../scripts/check-dependencies.mjs";

const name = "matcher@4.0.7";
const entry = {
  name,
  version: "4.0.7-a",
  replacementName: "@tooling/matcher",
  runtime: false,
};
const replacement = {
  name: "@tooling/matcher",
  version: "4.0.7-a",
  runtime: false,
  license: "MIT",
  approvedBy: "Dependency review",
  reviewDate: "2026-11-18",
  securityOwner: "Implementation controller",
  replacementPath: "Use the patched upstream package",
};
const pinnedAlias = "npm:@tooling/matcher@4.0.7-a";

describe("reviewed dependency overrides", () => {
  it("registers an exact alias under the replacement package's identity", () => {
    expect(
      checkDependencies([], [replacement], [entry], { [name]: pinnedAlias }),
    ).toBe(1);
    expect(() =>
      checkDependencies([], [{ ...replacement, name: "matcher" }], [entry], {
        [name]: pinnedAlias,
      }),
    ).toThrow("Unregistered or misclassified dependency");
    expect(() =>
      checkDependencies([], [{ ...replacement, runtime: true }], [entry], {
        [name]: pinnedAlias,
      }),
    ).toThrow("Unregistered or misclassified dependency");
  });

  it.each([
    "npm:@tooling/matcher@^4.0.7",
    "npm:@tooling/matcher@4.0.7-b",
    "npm:@another/matcher@4.0.7-a",
    "https://example.invalid/matcher.tgz",
    "4.0.7-a",
  ])("rejects an override that differs from the reviewed pin %s", (spec) => {
    expect(() =>
      checkDependencies([], [replacement], [entry], { [name]: spec }),
    ).toThrow("Unreviewed workspace override");
  });

  it("requires an exact affected version and development-only classification", () => {
    expect(() =>
      checkDependencies([], [replacement], [{ ...entry, name: "matcher" }], {
        matcher: pinnedAlias,
      }),
    ).toThrow("Invalid or duplicate override review");
    expect(() =>
      checkDependencies([], [replacement], [{ ...entry, runtime: true }], {
        [name]: pinnedAlias,
      }),
    ).toThrow("Invalid or duplicate override review");
  });

  it("preserves plain exact overrides and rejects aliases in direct manifests", () => {
    expect(
      checkDependencies(
        [],
        [{ ...replacement, name: "matcher", version: "4.0.7" }],
        [{ name: "matcher", version: "4.0.7", runtime: false }],
        { matcher: "4.0.7" },
      ),
    ).toBe(1);
    expect(() =>
      checkDependencies([{ devDependencies: { matcher: pinnedAlias } }], []),
    ).toThrow("Exact dependency version required");
  });
});

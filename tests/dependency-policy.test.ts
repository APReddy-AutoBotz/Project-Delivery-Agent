import { expect, it } from "vitest";
import { checkDependencies } from "../scripts/check-dependencies.mjs";
import { load } from "js-yaml";
it("CI-MNT-004: rejects missing, misclassified, floating and unapproved direct dependencies", () => {
  const manifest = { dependencies: { example: "1.2.3" } };
  const record = {
    name: "example",
    version: "1.2.3",
    runtime: true,
    license: "MIT",
    approvedBy: "review",
    reviewDate: "2026-09-06",
    securityOwner: "owner",
    replacementPath: "adapter",
  };
  expect(checkDependencies([manifest], [record])).toBe(1);
  expect(() => checkDependencies([manifest], [])).toThrow();
  expect(() =>
    checkDependencies([manifest], [{ ...record, runtime: false }]),
  ).toThrow();
  expect(() =>
    checkDependencies([manifest], [{ ...record, license: "GPL-3.0" }]),
  ).toThrow();
  expect(() =>
    checkDependencies([manifest], [{ ...record, license: "UNKNOWN" }]),
  ).toThrow();
  expect(() =>
    checkDependencies([manifest], [{ ...record, approvedBy: "" }]),
  ).toThrow();
  expect(() =>
    checkDependencies([{ dependencies: { example: "^1.2.3" } }], [record]),
  ).toThrow();
});

it("CI-MNT-004: rejects actual workspace override drift independently of unchanged review records", () => {
  const reviewed = [{ name: "example", version: "1.2.3", runtime: false }];
  const record = {
    ...reviewed[0],
    license: "MIT",
    approvedBy: "review",
    reviewDate: "2026-09-06",
    securityOwner: "owner",
    replacementPath: "adapter",
  };
  const verify = (yaml: string) =>
    checkDependencies(
      [],
      [record],
      reviewed,
      (load(yaml) as { overrides: unknown }).overrides,
    );
  expect(verify("overrides:\n  example: 1.2.3\n")).toBe(1);
  for (const yaml of [
    "overrides:\n  example: 1.2.4\n",
    "overrides:\n  example: ^1.2.3\n",
    "overrides:\n  example: 1.2.3\n  unexpected: 4.5.6\n",
    "overrides: {}\n",
    "overrides: [example]\n",
  ])
    expect(() => verify(yaml)).toThrow();
});

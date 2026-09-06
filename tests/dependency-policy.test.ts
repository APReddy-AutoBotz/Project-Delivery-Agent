import { expect, it } from "vitest";
import { checkDependencies } from "../scripts/check-dependencies.mjs";
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

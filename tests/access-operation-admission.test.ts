import { expect, it } from "vitest";
import { createAccessOperationAdmission } from "../packages/data/src/access-operation-admission.js";

it("bounds in-flight and poisoned permits without queuing or double release", () => {
  const admission = createAccessOperationAdmission();
  const first = admission.acquire()!, second = admission.acquire()!, third = admission.acquire()!, fourth = admission.acquire()!;
  expect(admission.acquire()).toBeNull();
  first.poison(); second.complete();
  expect(admission.status()).toEqual({ used: 3, poisoned: 1, limit: 4 });
  expect(() => first.complete()).toThrow(); expect(() => second.complete()).toThrow();
  const replacement = admission.acquire()!; expect(admission.acquire()).toBeNull();
  third.poison(); fourth.poison(); replacement.poison();
  expect(admission.status()).toEqual({ used: 4, poisoned: 4, limit: 4 });
  expect(admission.acquire()).toBeNull();
});

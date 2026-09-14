import { describe, expect, it } from "vitest";
import {
  assertScalarIdentityExecution,
  assertScalarIdentityVectors,
} from "../scripts/acceptance/scalar-identity-vectors-receipt.mjs";

const execution = () => ({
  principal: { role: "pdaa_api", login: "pdaa_api", pid: 123 },
  callbackReturned: true,
  settled: true,
  options: { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 },
});
describe("FR-EVD-012 / NFR-REL-001 native identity receipt transport", () => {
  it("accepts a settled actual-role command with unchanged transaction limits", () => {
    expect(assertScalarIdentityExecution(execution())).toBe(true);
  });
  it.each([
    "role",
    "login",
    "pid",
    "callback",
    "settled",
    "timeout",
    "isolation",
    "maxWait",
  ])("rejects changed %s evidence", (kind) => {
    const value = execution();
    if (kind === "role") value.principal.role = "fixture_admin";
    if (kind === "login") value.principal.login = "fixture_admin";
    if (kind === "pid") value.principal.pid = 0;
    if (kind === "callback") value.callbackReturned = false;
    if (kind === "settled") value.settled = false;
    if (kind === "timeout") value.options.timeout = 20000;
    if (kind === "isolation") value.options.isolationLevel = "Serializable";
    if (kind === "maxWait") value.options.maxWait = 10000;
    expect(() => assertScalarIdentityExecution(value)).toThrow();
  });
  it("rejects absent typed-vector coverage rather than treating it as optional", () => {
    expect(() =>
      assertScalarIdentityVectors(
        {
          family: "scalar-identity-vectors/v1",
          customerId: "customer",
          cases: [],
        },
        "customer",
      ),
    ).toThrow();
    expect(() => assertScalarIdentityVectors(undefined, "customer")).toThrow();
  });
});

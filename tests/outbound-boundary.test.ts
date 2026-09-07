import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createOutboundDispatcher,
  loadConfig,
} from "../packages/platform/src/index.js";

const permitted = { shadow: false, permitted: true, humanApproved: true };
const configuration = () =>
  loadConfig({
    NODE_ENV: "test",
    DATA_MODE: "synthetic",
    AUTH_MODE: "development",
    CUSTOMER_ID: "10000000-0000-4000-8000-000000000001",
    PDAA_DATABASE_URL: "postgresql://pdaa:fixture@127.0.0.1:55432/pdaa_test",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
  });

it("SEC-OUTBOUND-003: default and malformed configuration deny without consulting the adapter", async () => {
  const records: string[] = [];
  const readPolicy = vi.fn(() => permitted);
  for (const config of [
    configuration(),
    undefined,
    null,
    {},
    { SHADOW_MODE: false },
    { SHADOW_MODE: "invalid" },
  ]) {
    const execute = createOutboundDispatcher({
      readConfiguration: () => config as never,
      readPolicy,
      dispatch: async () => {
        records.push("dispatch");
      },
    });
    await expect(execute()).rejects.toThrow("Outbound action blocked");
  }
  expect(readPolicy).not.toHaveBeenCalled();
  expect(records).toEqual([]);
});

it("SEC-OUTBOUND-003: trusted current policy is re-read and invocation arguments cannot approve", async () => {
  const records: string[] = [];
  let policy: unknown = { ...permitted, humanApproved: false };
  const readPolicy = vi.fn(() => policy);
  const execute = createOutboundDispatcher({
    readConfiguration: () => ({ SHADOW_MODE: "false" }),
    readPolicy,
    dispatch: async () => {
      records.push("bound operation");
      return "recorded";
    },
  });
  await expect(
    (execute as Function)(permitted, () => records.push("replacement")),
  ).rejects.toThrow("Outbound action blocked");
  expect(records).toEqual([]);
  policy = permitted;
  expect(await execute()).toBe("recorded");
  expect(records).toEqual(["bound operation"]);
  policy = { ...permitted, permitted: false };
  await expect(execute()).rejects.toThrow("Outbound action blocked");
  expect(records).toEqual(["bound operation"]);
  expect(readPolicy).toHaveBeenCalledTimes(3);
});

it("SEC-OUTBOUND-003: shadow activation while policy lookup is pending prevents dispatch", async () => {
  const records: string[] = [];
  let shadow: "true" | "false" = "false";
  let resolvePolicy!: (value: unknown) => void;
  const execute = createOutboundDispatcher({
    readConfiguration: () => ({ SHADOW_MODE: shadow }),
    readPolicy: () =>
      new Promise((resolve) => {
        resolvePolicy = resolve;
      }),
    dispatch: async () => {
      records.push("dispatch");
    },
  });
  const pending = execute();
  shadow = "true";
  resolvePolicy(permitted);
  await expect(pending).rejects.toThrow("Outbound action blocked");
  expect(records).toEqual([]);
});

it("SEC-OUTBOUND-003: reader errors and extra policy fields fail closed with safe errors", async () => {
  const records: string[] = [];
  const canary = randomBytes(32).toString("hex");
  for (const stage of [
    "configuration",
    "policy",
    "final-configuration",
    "extra-fields",
  ]) {
    let reads = 0;
    const execute = createOutboundDispatcher({
      readConfiguration: () => {
        if (
          stage === "configuration" ||
          (stage === "final-configuration" && reads++ > 0)
        )
          throw new Error(canary);
        return { SHADOW_MODE: "false" };
      },
      readPolicy: async () => {
        if (stage === "policy") throw new Error(canary);
        return stage === "extra-fields"
          ? { ...permitted, action: canary }
          : permitted;
      },
      dispatch: async () => {
        records.push("dispatch");
      },
    });
    await expect(execute()).rejects.toThrow(/^Outbound action blocked$/);
  }
  expect(records).toEqual([]);
});

it("SEC-OUTBOUND-003: policy evaluation cannot activate shadow after the final configuration check", async () => {
  let shadow: "true" | "false" = "false";
  const dispatch = vi.fn(async () => "sent");
  const execute = createOutboundDispatcher({
    readConfiguration: () => ({ SHADOW_MODE: shadow }),
    readPolicy: () => ({
      ...permitted,
      get shadow() {
        shadow = "true";
        return false;
      },
    }),
    dispatch,
  });
  await expect(execute()).rejects.toThrow("Outbound action blocked");
  expect(dispatch).not.toHaveBeenCalled();
});

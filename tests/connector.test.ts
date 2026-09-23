import { describe, expect, it } from "vitest";
import {
  connectorFailureSchema,
  connectorReadRetryAdvice,
  connectorRecordIdentity,
  validateConnectorConnection,
  validateConnectorDeepLink,
  validateConnectorDiscovery,
  validateConnectorPage,
  validateConnectorRecord,
} from "../packages/domain/src/connector.js";
import {
  createSyntheticReadConnector,
  fixtureScope,
  fixtureRecord,
} from "./fixtures/connector-read-fixture.js";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = {
  customerId: id(1),
  sourceId: id(2),
  sourceType: "synthetic",
  origin: "https://source.example",
};
const scope = { binding, projectIds: [id(3)] };
const ref = {
  customerId: id(1),
  sourceId: id(2),
  projectId: id(3),
  recordType: "issue",
  recordId: "A-1",
};
const record = {
  ref,
  revision: "rev1",
  sourceContentHash: "a".repeat(64),
  observedAt: "2026-09-22T11:00:00.000Z",
  effectiveAt: "2026-09-21T00:00:00.000Z",
  deepLink: "https://source.example/browse/A-1",
  observations: [
    { factType: "status", value: { type: "text", value: "Open" } },
  ],
};
const request = { scope, cursor: null };
const page = () => ({
  binding,
  inputCursor: null,
  nextCursor: "cursor1",
  terminal: false,
  records: [structuredClone(record)],
});

describe("internal synthetic read contract (FR-CON-011/012, TR-TEST-003)", () => {
  it("exercises the first-party adapter port through connection, discovery, paging and exact record lookup", async () => {
    const adapter = createSyntheticReadConnector();
    const connection = await adapter.testConnection(fixtureScope);
    const discovery = await adapter.discoverScopes(fixtureScope);
    expect(
      connection.ok && validateConnectorConnection(connection.value),
    ).toBeTruthy();
    expect(
      discovery.ok && validateConnectorDiscovery(fixtureScope, discovery.value),
    ).toBeTruthy();
    const first = await adapter.pullChanges({
      scope: fixtureScope,
      cursor: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Fixture failed");
    expect(first.value.records).toEqual([fixtureRecord]);
    const last = await adapter.pullChanges({
      scope: fixtureScope,
      cursor: first.value.nextCursor,
    });
    expect(last).toMatchObject({
      ok: true,
      value: { terminal: true, records: [], nextCursor: null },
    });
    expect(await adapter.getRecord(fixtureScope, fixtureRecord.ref)).toEqual({
      ok: true,
      value: fixtureRecord,
    });
    expect(adapter.getDeepLink(fixtureScope, fixtureRecord.ref)).toBe(
      fixtureRecord.deepLink,
    );
    expect(() =>
      adapter.pullChanges({
        scope: { ...fixtureScope, projectIds: [id(9)] },
        cursor: null,
      }),
    ).toThrow("SCOPE_MISMATCH");
  });
  it.each([
    "PERMISSION_DENIED",
    "EXPIRED_CREDENTIALS",
    "RATE_LIMITED",
    "UNKNOWN_OUTCOME",
  ] as const)(
    "retains a finite %s through the synthetic port without executing a retry",
    async (code) => {
      const failure = {
        code,
        retryAfterMs: code === "RATE_LIMITED" ? 10_000 : null,
      };
      const adapter = createSyntheticReadConnector(failure);
      for (const value of [
        await adapter.testConnection(fixtureScope),
        await adapter.discoverScopes(fixtureScope),
        await adapter.getRecord(fixtureScope, fixtureRecord.ref),
        await adapter.pullChanges({ scope: fixtureScope, cursor: null }),
      ])
        expect(value).toEqual({ ok: false, failure });
      expect(connectorReadRetryAdvice(failure, 1).retry).toBe(
        code === "RATE_LIMITED",
      );
    },
  );
  it("preserves exact identity, typed observations, revisions and source times without adding provenance", () => {
    const input = page(),
      before = structuredClone(input);
    const result = validateConnectorPage(request, input);
    expect(result).toEqual(before);
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(result.records[0]).not.toHaveProperty("provenance");
    expect(connectorRecordIdentity(ref)).not.toBe(
      connectorRecordIdentity({ ...ref, projectId: id(4) }),
    );
  });
  it("accepts terminal empty and final populated pages", () => {
    expect(
      validateConnectorPage(request, {
        ...page(),
        terminal: true,
        nextCursor: null,
        records: [],
      }).records,
    ).toEqual([]);
    expect(
      validateConnectorPage(request, {
        ...page(),
        terminal: true,
        nextCursor: null,
      }).records,
    ).toHaveLength(1);
  });
  it.each([
    { inputCursor: "other" },
    { nextCursor: null },
    { records: [] },
    { terminal: true },
  ])("rejects malformed cursor transition %j", (change) => {
    expect(() =>
      validateConnectorPage(request, { ...page(), ...change }),
    ).toThrow("INVALID_CURSOR");
  });
  it("rejects repeating a non-null cursor", () => {
    expect(() =>
      validateConnectorPage(
        { ...request, cursor: "cursor1" },
        { ...page(), inputCursor: "cursor1" },
      ),
    ).toThrow("INVALID_CURSOR");
  });
  it.each(["customerId", "sourceId", "projectId"] as const)(
    "rejects returned record %s scope drift",
    (key) => {
      const value = page();
      value.records[0]!.ref[key] = id(9);
      expect(() => validateConnectorPage(request, value)).toThrow(
        "SCOPE_MISMATCH",
      );
    },
  );
  it.each(["customerId", "sourceId", "sourceType", "origin"] as const)(
    "rejects returned binding %s drift",
    (key) => {
      expect(() =>
        validateConnectorPage(request, {
          ...page(),
          binding: {
            ...binding,
            [key]:
              key === "origin"
                ? "https://other.example"
                : key.endsWith("Id")
                  ? id(9)
                  : "other",
          },
        }),
      ).toThrow("SCOPE_MISMATCH");
    },
  );
  it("rejects duplicate records even with a different revision", () => {
    expect(() =>
      validateConnectorPage(request, {
        ...page(),
        records: [record, { ...record, revision: "rev2" }],
      }),
    ).toThrow("DUPLICATE_RECORD");
  });
  it("getRecord cannot substitute another external record", () => {
    expect(validateConnectorRecord(scope, ref, record)).toEqual(record);
    expect(() =>
      validateConnectorRecord(scope, { ...ref, recordId: "A-2" }, record),
    ).toThrow("RECORD_MISMATCH");
  });
  it.each(["not-a-digest", "A".repeat(64), "f".repeat(63)])(
    "requires a lowercase SHA-256 source digest (%s)",
    (sourceContentHash) => {
      expect(() =>
        validateConnectorPage(request, {
          ...page(),
          records: [{ ...record, sourceContentHash }],
        }),
      ).toThrow("INVALID_INPUT");
    },
  );
  it.each([
    "javascript:alert(1)",
    "http://source.example/a",
    "https://user@source.example/a",
    "https://other.example/a",
    "//source.example/a",
    "https://source.example\\evil",
    " https://source.example/a",
  ])("rejects untrusted link %s", (link) => {
    expect(() => validateConnectorDeepLink(scope, link)).toThrow(
      "INVALID_LINK",
    );
  });
  it("keeps null links non-navigable", () =>
    expect(validateConnectorDeepLink(scope, null)).toBeNull());
  it("validates bounded discovery and connection timestamps", () => {
    const checkedAt = record.observedAt;
    expect(validateConnectorConnection({ checkedAt })).toEqual({ checkedAt });
    expect(
      validateConnectorDiscovery(scope, { projectIds: [id(3)], checkedAt })
        .projectIds,
    ).toEqual([id(3)]);
    expect(() =>
      validateConnectorDiscovery(scope, { projectIds: [id(4)], checkedAt }),
    ).toThrow("SCOPE_MISMATCH");
    expect(() =>
      validateConnectorDiscovery(scope, {
        projectIds: [id(3), id(3)],
        checkedAt,
      }),
    ).toThrow("INVALID_INPUT");
    expect(() =>
      validateConnectorConnection({ checkedAt: "0000-01-01T00:00:00.000Z" }),
    ).toThrow("INVALID_INPUT");
  });
  it("rejects oversized pages before touching their entries", () => {
    const oversized = Array(101);
    Object.defineProperty(oversized, 0, {
      get() {
        throw new Error("ENTRY_TOUCHED");
      },
    });
    expect(() =>
      validateConnectorPage(request, { ...page(), records: oversized }),
    ).toThrow("INVALID_INPUT");
  });
  it("accepts exactly 100 records and 32 mapped fields without dropping any", () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      ...record,
      ref: { ...ref, recordId: `A-${index}` },
      observations: Array.from({ length: 32 }, (_, field) => ({
        factType: `field_${field}`,
        value: { type: "number", value: field },
      })),
    }));
    const result = validateConnectorPage(request, { ...page(), records });
    expect(result.records).toHaveLength(100);
    expect(
      result.records.every((item) => item.observations.length === 32),
    ).toBe(true);
  });
  it("rejects oversized fields and project scope before touching their entries", () => {
    for (const [name, limit] of [
      ["observations", 32],
      ["projectIds", 100],
    ] as const) {
      const values = Array(limit + 1);
      Object.defineProperty(values, 0, {
        get() {
          throw new Error("ENTRY_TOUCHED");
        },
      });
      expect(() =>
        name === "observations"
          ? validateConnectorPage(request, {
              ...page(),
              records: [{ ...record, observations: values }],
            })
          : validateConnectorPage(
              { scope: { ...scope, projectIds: values }, cursor: null },
              page(),
            ),
      ).toThrow("INVALID_INPUT");
    }
  });
  it("rejects duplicate fact types, unknown keys and invalid typed values", () => {
    for (const changed of [
      {
        ...record,
        observations: [record.observations[0], record.observations[0]],
      },
      { ...record, token: "not-a-real-token" },
      {
        ...record,
        observations: [
          { factType: "due", value: { type: "date", value: "2026-02-30" } },
        ],
      },
    ])
      expect(() =>
        validateConnectorPage(request, { ...page(), records: [changed] }),
      ).toThrow("INVALID_INPUT");
  });
  it.each([
    "PERMISSION_DENIED",
    "INVALID_CREDENTIALS",
    "EXPIRED_CREDENTIALS",
    "UNKNOWN_OUTCOME",
    "NOT_FOUND",
    "INVALID_RESPONSE",
  ])("never automatically retries %s", (code) => {
    expect(connectorReadRetryAdvice({ code, retryAfterMs: null }, 1)).toEqual({
      retry: false,
    });
  });
  it.each(["RATE_LIMITED", "TEMPORARILY_UNAVAILABLE"])(
    "honors Retry-After and caps attempts for %s",
    (code) => {
      expect(
        connectorReadRetryAdvice({ code, retryAfterMs: 86_400_000 }, 1),
      ).toEqual({ retry: true, delayMs: 86_400_000 });
      expect(connectorReadRetryAdvice({ code, retryAfterMs: 100 }, 4)).toEqual({
        retry: true,
        delayMs: 8000,
      });
      expect(connectorReadRetryAdvice({ code, retryAfterMs: null }, 5)).toEqual(
        { retry: false },
      );
    },
  );
  it.each([0, -1, 1.5, 6, Infinity, NaN])(
    "rejects invalid attempt %s",
    (attempt) => {
      expect(() =>
        connectorReadRetryAdvice(
          { code: "RATE_LIMITED", retryAfterMs: null },
          attempt,
        ),
      ).toThrow("INVALID_ATTEMPT");
    },
  );
  it("rejects unclassified errors and inappropriate/oversized retry hints", () => {
    for (const error of [
      new Error("sensitive"),
      { code: "UNKNOWN", retryAfterMs: null },
      { code: "PERMISSION_DENIED", retryAfterMs: 1 },
      { code: "RATE_LIMITED", retryAfterMs: 86_400_001 },
      { code: "RATE_LIMITED", retryAfterMs: 1, message: "sensitive" },
    ])
      expect(connectorFailureSchema.safeParse(error).success).toBe(false);
  });
});

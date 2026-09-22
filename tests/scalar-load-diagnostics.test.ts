// NFR-REL-001, NFR-OBS-001: no sleeps, fake SQL, or weakened deadline.
import { expect, it, vi } from "vitest";
import {
  measureScalarLoad,
  assertScalarLoadMeasurement,
} from "../scripts/acceptance/scalar-load-diagnostics.mjs";

const samples = (duration: number) => {
  let n = 0;
  return () =>
    ++n === 1
      ? {
          now: 100,
          cpu: { user: 1000, system: 2000 },
          loop: { active: 5, idle: 10 },
        }
      : {
          now: 100 + duration,
          cpu: { user: 6000, system: 5000 },
          loop: { active: 8, idle: 15 },
        };
};
it("preserves the returned object and publishes a closed content-free measurement", async () => {
  const value = { secret: "sensitive result" },
    publish = vi.fn();
  const result = await measureScalarLoad(
    async () => value,
    publish,
    samples(9999),
  );
  expect(result.value).toBe(value);
  expect(result.measurement).toEqual({
    family: "scalar-load-measurement/v1",
    deadlineMs: 10000,
    commandState: "returned",
    durationMs: 9999,
    deadlineExceeded: false,
    cpuUserMs: 5,
    cpuSystemMs: 3,
    eventLoopActiveMs: 3,
    eventLoopIdleMs: 5,
  });
  expect(publish).toHaveBeenCalledExactlyOnceWith(result.measurement);
  expect(JSON.stringify(result.measurement)).not.toContain("sensitive");
});
it("publishes returned-but-over-budget evidence before rejecting at the exact deadline", async () => {
  for (const duration of [10000, 10001]) {
    const publish = vi.fn();
    await expect(
      measureScalarLoad(async () => "returned", publish, samples(duration)),
    ).rejects.toThrow("Scalar command exceeded unchanged production deadline");
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      durationMs: duration,
      deadlineExceeded: true,
      commandState: "returned",
    });
  }
});
it("retains the original command failure without serializing its content or claiming rollback", async () => {
  const error = new Error("sensitive credentials"),
    publish = vi.fn();
  await expect(
    measureScalarLoad(
      async () => {
        throw error;
      },
      publish,
      samples(12000),
    ),
  ).rejects.toBe(error);
  expect(publish.mock.calls[0]?.[0]).toMatchObject({
    commandState: "rejected",
    durationMs: 12000,
    deadlineExceeded: true,
  });
  expect(JSON.stringify(publish.mock.calls)).not.toContain("sensitive");
});
it("preserves both command and diagnostic failures, including non-Error rejection", async () => {
  const diagnostic = new Error("publisher failed");
  for (const original of [new Error("command failed"), undefined]) {
    const failure = await measureScalarLoad(
      async () => {
        throw original;
      },
      async () => {
        throw diagnostic;
      },
      samples(20),
    ).catch((error: AggregateError) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([original, diagnostic]);
    expect(failure.cause).toBe(diagnostic);
  }
  await expect(
    measureScalarLoad(
      async () => true,
      async () => {
        throw diagnostic;
      },
      samples(20),
    ),
  ).rejects.toBe(diagnostic);
});
it("preserves a command failure if final telemetry collection fails", async () => {
  const command = new Error("command"),
    telemetry = new Error("sample");
  let n = 0;
  const failure = await measureScalarLoad(
    async () => {
      throw command;
    },
    vi.fn(),
    () => {
      if (++n === 2) throw telemetry;
      return samples(10)();
    },
  ).catch((e: AggregateError) => e);
  expect(failure.errors).toEqual([command, telemetry]);
});

it("keeps the deadline violation when its diagnostic publication also fails", async () => {
  const publisher = new Error("disk failure");
  const error = await measureScalarLoad(
    async () => true,
    async () => {
      throw publisher;
    },
    samples(10000),
  ).catch((e: AggregateError) => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors[0].message).toBe(
    "Scalar command exceeded unchanged production deadline",
  );
  expect(error.errors[1]).toBe(publisher);
});
it("refuses non-finite timings, changed budgets, contradictory states and extra content", async () => {
  const { measurement } = await measureScalarLoad(
    async () => true,
    vi.fn(),
    samples(20),
  );
  for (const patch of [
    { durationMs: NaN },
    { durationMs: -1 },
    { deadlineMs: 15000 },
    { deadlineExceeded: true },
    { commandState: "rolled-back" },
    { cpuUserMs: -1 },
    { eventLoopIdleMs: Infinity },
    { sql: "secret statement" },
  ])
    expect(() =>
      assertScalarLoadMeasurement({ ...measurement, ...patch }),
    ).toThrow();
});

// NFR-REL-001, NFR-OBS-001: preserve deadline evidence without changing commands.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const sample = () => ({
  cpu: process.cpuUsage(),
  loop: performance.eventLoopUtilization(),
  now: performance.now(),
});

export function assertScalarLoadMeasurement(row) {
  assert.equal(row.family, "scalar-load-measurement/v1");
  assert.equal(row.deadlineMs, 10000);
  assert(["returned", "rejected"].includes(row.commandState));
  assert(Number.isFinite(row.durationMs) && row.durationMs >= 0);
  assert.equal(row.deadlineExceeded, row.durationMs >= 10000);
  for (const key of [
    "cpuUserMs",
    "cpuSystemMs",
    "eventLoopActiveMs",
    "eventLoopIdleMs",
  ])
    assert(Number.isFinite(row[key]) && row[key] >= 0);
  // Process-wide deltas describe this observation interval, not DB CPU or causality.
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "family",
      "deadlineMs",
      "commandState",
      "durationMs",
      "deadlineExceeded",
      "cpuUserMs",
      "cpuSystemMs",
      "eventLoopActiveMs",
      "eventLoopIdleMs",
    ].sort(),
  );
}

export async function measureScalarLoad(command, publish, readSample = sample) {
  const before = readSample();
  let value,
    failure,
    rejected = false;
  try {
    value = await command();
  } catch (error) {
    rejected = true;
    failure = error;
  }
  let measurement;
  try {
    const after = readSample();
    measurement = {
      family: "scalar-load-measurement/v1",
      deadlineMs: 10000,
      commandState: rejected ? "rejected" : "returned",
      durationMs: after.now - before.now,
      deadlineExceeded: after.now - before.now >= 10000,
      cpuUserMs: (after.cpu.user - before.cpu.user) / 1000,
      cpuSystemMs: (after.cpu.system - before.cpu.system) / 1000,
      eventLoopActiveMs: after.loop.active - before.loop.active,
      eventLoopIdleMs: after.loop.idle - before.loop.idle,
    };
    assertScalarLoadMeasurement(measurement);
    if (!rejected && measurement.deadlineExceeded) {
      rejected = true;
      failure = new assert.AssertionError({
        message: "Scalar command exceeded unchanged production deadline",
        actual: measurement.durationMs,
        expected: "<10000ms",
      });
    }
    // Publication occurs outside the measured command interval, even on rejection.
    // No error messages, SQL, parameters, returned content or credentials are copied.
    await publish(measurement);
  } catch (publicationError) {
    if (rejected)
      throw new AggregateError(
        [failure, publicationError],
        "Scalar load command and diagnostic publication failed",
        { cause: publicationError },
      );
    throw publicationError;
  }
  if (rejected) throw failure;
  return { value, measurement };
}

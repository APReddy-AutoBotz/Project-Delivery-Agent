// NFR-REL-001: retain primary failures and finish cleanup on every fixture path.
export async function runWithCleanup(operation, cleanup) {
  const failures = [];
  let result;
  try {
    result = await operation();
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Fixture operation and cleanup failed");
  return result;
}

export async function drainAndClose(pending, closers, priorFailures = []) {
  const drained = await Promise.allSettled(pending);
  // Invoke closers only after all callbacks, COMMITs and denial audits settle.
  const closed = await Promise.allSettled(
    closers.map((close) => Promise.resolve().then(close)),
  );
  const failures = [
    ...priorFailures,
    ...[...drained, ...closed]
      .filter((item) => item.status === "rejected")
      .map((item) => item.reason),
  ];
  if (failures.length)
    throw new AggregateError(failures, "Fixture cleanup failed");
}

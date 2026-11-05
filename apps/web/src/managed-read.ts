import { ManagedReadRegistry, type ManagedReadEnd } from "./managed-read-registry.js";

export class ManagedReadCapacityError extends Error {
  constructor() { super("Managed read capacity is unavailable"); }
}
export class ManagedReadStaleError extends Error {
  constructor() { super("Managed read is no longer current"); }
}
export class ManagedReadIncompleteError extends Error {
  constructor() { super("Managed read cleanup could not be confirmed"); }
}

// The supplied signal is logical ownership only: dispatch must not forward it
// to an already-issued transport. One trusted adapter represents one original
// request, reports cleanup exactly once before its promise settles, and checks
// `live` at each scoped callback. The registry cannot verify those assertions.
export async function managedRead<T>(
  registry: ManagedReadRegistry,
  signal: AbortSignal,
  current: () => boolean,
  dispatch: (live: () => boolean, report: (end: ManagedReadEnd) => void) => Promise<T>,
): Promise<T> {
  const live = () => {
    if (signal.aborted) return false;
    try { return current() === true; } catch { return false; }
  };
  if (!live()) throw new ManagedReadStaleError();
  const lease = registry.begin();
  if (!lease) throw new ManagedReadCapacityError();
  if (!live()) { lease.finish("terminated"); throw new ManagedReadStaleError(); }
  let end: ManagedReadEnd = "unknown", reported = false;
  const report = (value: ManagedReadEnd) => {
    if (reported) { end = "unknown"; return; }
    reported = true;
    end = value === "eof" || value === "terminated" ? value : "unknown";
  };
  try {
    const result = await dispatch(live, report);
    if (!live()) throw new ManagedReadStaleError();
    if (!reported || end === "unknown") throw new ManagedReadIncompleteError();
    return result;
  } catch (error) {
    if (!live()) throw new ManagedReadStaleError();
    throw error;
  } finally { lease.finish(end); }
}

// FR-EVD-009/012: create once in the long-lived owner, outside individual
// selection/session resources. A timed-out operation retains the lease until
// its entire body/decode promise settles, even when it ignores cancellation.
export function createUnrankedRequestLease() {
  let active = false;
  return {
    run<T>(signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (active || signal.aborted) return Promise.reject(new Error("Observation unavailable"));
      active = true;
      return Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("Observation unavailable");
        return load(signal);
      }).then((value) => {
        if (signal.aborted) throw new Error("Observation unavailable");
        return value;
      }).catch(() => { throw new Error("Observation unavailable"); })
        .finally(() => { active = false; });
    },
  };
}

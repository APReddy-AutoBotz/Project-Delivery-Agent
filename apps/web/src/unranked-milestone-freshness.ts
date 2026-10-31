// FR-EVD-009/012: bounds displayed contributor validity only. It does not
// establish that source access, policy absence or the report is still current.
export function startUnrankedFreshnessClock(clock: { wall: () => number; monotonic: () => number } = {
  wall: () => Date.now(), monotonic: () => performance.now(),
}) {
  const wallStart = clock.wall(), monotonicStart = clock.monotonic();
  let lastWall = wallStart, lastMonotonic = monotonicStart;
  let invalid = !Number.isFinite(wallStart) || !Number.isFinite(monotonicStart);
  let bound = false;
  return {
    bind(asOf: string, validUntil: readonly string[]) {
      if (bound) throw new Error("Freshness clock already bound");
      bound = true;
      const parseInstant = (value: string) => {
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || value.startsWith("0000-")) return NaN;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
      };
      const asOfMs = parseInstant(asOf);
      let expiry = Infinity;
      if (validUntil.length > 1000) invalid = true;
      else for (const value of validUntil) expiry = Math.min(expiry, parseInstant(value));
      const ttl = expiry - asOfMs;
      if (!validUntil.length || !Number.isFinite(asOfMs) || !Number.isFinite(expiry) || !Number.isFinite(ttl) || ttl <= 0) invalid = true;
      return {
        // Returns zero permanently on invalid inputs, elapsed validity or any
        // observed clock regression. Call before publish, render and restore.
        remaining() {
          if (invalid) return 0;
          const wall = clock.wall(), monotonic = clock.monotonic();
          if (!Number.isFinite(wall) || !Number.isFinite(monotonic) || wall < lastWall || monotonic < lastMonotonic) {
            invalid = true; return 0;
          }
          lastWall = wall; lastMonotonic = monotonic;
          const left = Math.min(ttl - (wall - wallStart), ttl - (monotonic - monotonicStart));
          if (!Number.isFinite(left) || left <= 0) { invalid = true; return 0; }
          return left;
        },
      };
    },
  };
}

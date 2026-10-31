import { expect, it } from "vitest";
import { startUnrankedFreshnessClock } from "../apps/web/src/unranked-milestone-freshness.js";

const asOf = "2026-10-31T12:00:00.000Z", early = "2026-10-31T12:00:10.000Z", late = "2026-10-31T12:00:20.000Z";
const fixture = () => {
  let wall = 1000, monotonic = 500;
  const clock = startUnrankedFreshnessClock({ wall: () => wall, monotonic: () => monotonic });
  return { bind: (values: readonly string[] = [late, early]) => clock.bind(asOf, values),
    set: (w: number, m: number) => { wall = w; monotonic = m; } };
};

it("subtracts the entire request duration and uses the earliest contributor expiry", () => {
  const f = fixture(); f.set(3000, 2500);
  const guard = f.bind();
  expect(guard.remaining()).toBe(8000);
  f.set(10999, 10499); expect(guard.remaining()).toBe(1);
  f.set(11000, 10500); expect(guard.remaining()).toBe(0);
  f.set(12000, 11500); expect(guard.remaining()).toBe(0);
});

it("expires if either clock advances through the limit during suspension", () => {
  const wallAdvances = fixture(), a = wallAdvances.bind();
  wallAdvances.set(11000, 500); expect(a.remaining()).toBe(0);
  const monotonicAdvances = fixture(), b = monotonicAdvances.bind();
  monotonicAdvances.set(1000, 10500); expect(b.remaining()).toBe(0);
});

it("fails closed permanently on observed clock regression or nonfinite readings", () => {
  const f = fixture(), guard = f.bind();
  f.set(5000, 4500); expect(guard.remaining()).toBe(6000);
  f.set(4999, 4600); expect(guard.remaining()).toBe(0);
  f.set(6000, 5500); expect(guard.remaining()).toBe(0);
  const g = fixture(), other = g.bind();
  g.set(1500, 1000); expect(other.remaining()).toBe(9500);
  g.set(1600, 999); expect(other.remaining()).toBe(0);
  const h = fixture(), invalid = h.bind(); h.set(Number.NaN, 1000); expect(invalid.remaining()).toBe(0);
});

it("rejects missing, invalid and already-expired bounds and cannot be rebound", () => {
  expect(fixture().bind(Array.from({ length: 1000 }, () => late)).remaining()).toBe(20000);
  for (const values of [[], ["not-a-date"], ["2026-02-30T12:00:00.000Z"], ["2026-10-31T12:00:10Z"],
    [asOf], ["2026-10-31T11:59:59.999Z"], Array.from({ length: 1001 }, () => late)]) {
    const f = fixture(); expect(f.bind(values).remaining()).toBe(0);
  }
  const f = fixture(); f.bind(); expect(() => f.bind()).toThrow();
  const badStart = startUnrankedFreshnessClock({ wall: () => Infinity, monotonic: () => 0 });
  expect(badStart.bind(asOf, [early]).remaining()).toBe(0);
  const clock = startUnrankedFreshnessClock({ wall: () => 1, monotonic: () => 1 });
  expect(clock.bind("2026-02-30T12:00:00.000Z", [early]).remaining()).toBe(0);
});

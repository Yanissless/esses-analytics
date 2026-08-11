import { describe, expect, it } from "vitest";
import {
  deltas,
  followersPerSubscriber,
  indexToBase,
  lagProfile,
  MIN_POINTS_FOR_R,
  pearson,
  periodGrowthRate,
} from "../src/metrics/audience-growth";

/**
 * Correlating follower growth against subscriber growth.
 *
 * The trap this whole module exists to avoid: two series that both trend upward
 * correlate near 1.0 whether or not one has anything to do with the other. Follower
 * count and subscriber count both rise over time, so a Pearson r on the LEVELS is
 * guaranteed to look conclusive and mean nothing. The first test below is the one that
 * matters — it pins the difference between the impressive number and the useful one.
 */

/** n points so correlation is measurable; keeps the arithmetic tests honest. */
const N = MIN_POINTS_FOR_R;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("levels correlate spuriously; changes do not", () => {
  it("reports r near 1 on two unrelated rising series, and no correlation on their changes", () => {
    // Followers climb steadily. Subscribers also climb, but their week-to-week movement
    // is deliberately anti-phased with the follower movement — there is no relationship
    // in the changes at all.
    const followers = range(N).map((i) => 1000 + i * 100);
    const subscribers = range(N).map((i) => 500 + i * 10 + (i % 2 === 0 ? 8 : -8));

    const levelR = pearson(followers, subscribers);
    expect(levelR).not.toBeNull();
    // The spurious result: both go up, so r is enormous.
    expect(levelR as number).toBeGreaterThan(0.95);

    // Followers rise by a constant 100/week, so their deltas have zero variance and the
    // correlation on changes is correctly not measurable rather than impressively high.
    expect(pearson(deltas(followers), deltas(subscribers))).toBeNull();
  });

  it("finds a real relationship when the changes actually move together", () => {
    const followerDeltas = [40, 90, 20, 75, 15, 60, 35, 85, 25, 70, 50, 95, 30];
    // Subscriber change tracks follower change, scaled down, with light noise.
    const subscriberDeltas = followerDeltas.map((d, i) => d / 10 + (i % 3 === 0 ? 0.4 : -0.3));

    const r = pearson(followerDeltas, subscriberDeltas);
    expect(r).not.toBeNull();
    expect(r as number).toBeGreaterThan(0.9);
  });
});

describe("pearson refuses rather than guesses", () => {
  it("returns null below the minimum sample size", () => {
    const xs = range(MIN_POINTS_FOR_R - 1);
    const ys = xs.map((i) => i * 2);
    expect(pearson(xs, ys)).toBeNull();
    // One more point and the same perfectly-correlated data becomes measurable.
    expect(pearson([...xs, 99], [...ys, 198])).toBeCloseTo(1, 10);
  });

  it("returns null on mismatched lengths", () => {
    expect(pearson(range(N), range(N - 1))).toBeNull();
  });

  it("returns null (not 0) for a flat series", () => {
    // Rule 3: a zero denominator means "not measurable", never zero. A flat follower
    // count correlating with anything at 0 would read as "no relationship", which is a
    // different and unsupported claim.
    const flat = range(N).map(() => 4200);
    expect(pearson(flat, range(N))).toBeNull();
    expect(pearson(range(N), flat)).toBeNull();
  });

  it("computes the textbook values for perfect correlation and anti-correlation", () => {
    const xs = range(N);
    expect(pearson(xs, xs.map((i) => 3 * i + 7))).toBeCloseTo(1, 10);
    expect(pearson(xs, xs.map((i) => -3 * i + 7))).toBeCloseTo(-1, 10);
  });
});

describe("deltas", () => {
  it("returns period-over-period changes, one shorter than the input", () => {
    expect(deltas([10, 14, 12, 20])).toEqual([4, -2, 8]);
  });

  it("is empty for a series too short to have a change", () => {
    expect(deltas([5])).toEqual([]);
    expect(deltas([])).toEqual([]);
  });
});

describe("lagProfile", () => {
  it("identifies the lag at which one series leads the other", () => {
    // Subscriber change is follower change shifted forward by 3 weeks: followers move
    // first. Long enough that lag 3 still clears the minimum sample size.
    const followerDeltas = [5, 40, 12, 70, 8, 55, 30, 90, 18, 65, 25, 80, 14, 48, 36, 75];
    const lead = 3;
    const subscriberDeltas = [
      ...range(lead).map(() => 1),
      ...followerDeltas.slice(0, followerDeltas.length - lead).map((d) => d / 5),
    ];

    const { best } = lagProfile(followerDeltas, subscriberDeltas, 6);
    expect(best).not.toBeNull();
    expect(best?.lag).toBe(lead);
    expect(best?.r as number).toBeGreaterThan(0.9);
  });

  it("searches only non-negative lags", () => {
    const { profile } = lagProfile(range(30), range(30), 5);
    expect(profile.map((p) => p.lag)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("returns a null best when no lag has enough overlapping points", () => {
    // Each lag costs an observation, so a short series is unmeasurable at every lag.
    const short = range(6);
    const { best, profile } = lagProfile(short, short, 4);
    expect(best).toBeNull();
    expect(profile.every((p) => p.r === null)).toBe(true);
  });
});

describe("periodGrowthRate", () => {
  it("computes a compound per-period rate", () => {
    // 100 -> 121 over two periods is 10% per period.
    expect(periodGrowthRate([100, 110, 121])).toBeCloseTo(0.1, 10);
  });

  it("returns null rather than infinity when starting from zero", () => {
    // "We had no followers and now have 500" is an undefined rate, not an infinite one.
    expect(periodGrowthRate([0, 100, 500])).toBeNull();
  });

  it("returns null for a series too short to have a rate", () => {
    expect(periodGrowthRate([100])).toBeNull();
    expect(periodGrowthRate([])).toBeNull();
  });

  it("handles decline", () => {
    expect(periodGrowthRate([121, 110, 100])).toBeCloseTo(-0.0909, 4);
  });
});

describe("indexToBase", () => {
  /**
   * Indexing is what lets ~18,000 followers and ~2,000 subscribers share one y-axis.
   * The alternative — a dual-axis chart — lets you place the two scales so the lines
   * cross wherever you like, which makes the comparison unfalsifiable.
   */
  it("rebases the first real value to 100 and scales the rest proportionally", () => {
    const out = indexToBase([15820, 16610, 18340]);
    expect(out[0]).toBe(100);
    expect(out[1] as number).toBeCloseTo((16610 / 15820) * 100, 10);
    expect(out[2] as number).toBeCloseTo((18340 / 15820) * 100, 10);
  });

  it("puts two different-scale series on a comparable footing", () => {
    const followers = indexToBase([16000, 17600]); // +10%
    const subscribers = indexToBase([1000, 1200]); // +20%
    expect(followers[0]).toBe(100);
    expect(followers[1] as number).toBeCloseTo(110, 10);
    expect(subscribers[1] as number).toBeCloseTo(120, 10);
    // Subscribers grew faster, and on the indexed axis that is directly visible.
    expect((subscribers[1] as number) > (followers[1] as number)).toBe(true);
  });

  it("preserves nulls as gaps rather than interpolating them", () => {
    expect(indexToBase([200, null, 300])).toEqual([100, null, 150]);
  });

  it("returns all nulls when there is no usable base", () => {
    expect(indexToBase([null, null])).toEqual([null, null]);
    // A series starting at zero has no meaningful base to index against.
    expect(indexToBase([0, 0])).toEqual([null, null]);
  });

  it("skips a leading zero to find the first real base", () => {
    expect(indexToBase([0, 50, 100])).toEqual([0, 100, 200]);
  });
});

describe("followersPerSubscriber", () => {
  it("divides follower growth by net subscriber growth", () => {
    expect(followersPerSubscriber(5000, 100)).toBe(50);
  });

  it("is not measurable when subscribers did not grow", () => {
    // Rule 3 again: zero net adds is not "infinity followers per subscriber".
    expect(followersPerSubscriber(5000, 0)).toBeNull();
  });
});

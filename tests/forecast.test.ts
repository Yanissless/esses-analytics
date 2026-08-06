import { describe, expect, it } from "vitest";
import {
  daysElapsed,
  daysInMonth,
  GOAL_METRICS,
  GOAL_METRIC_IDS,
  isGoalMetric,
  paceVsTarget,
  projectPeriod,
} from "../src/metrics/forecast";

describe("daysInMonth", () => {
  it("handles month lengths and leap years", () => {
    expect(daysInMonth("2026-01-15")).toBe(31);
    expect(daysInMonth("2026-04-01")).toBe(30);
    expect(daysInMonth("2026-02-01")).toBe(28);
    expect(daysInMonth("2028-02-01")).toBe(29); // leap
    expect(daysInMonth("2026-12-31")).toBe(31);
  });
});

describe("daysElapsed", () => {
  it("counts the current day as elapsed", () => {
    expect(daysElapsed("2026-08-01", "2026-08-01")).toBe(1);
    expect(daysElapsed("2026-08-01", "2026-08-15")).toBe(15);
  });

  it("returns the full month once the period is over", () => {
    expect(daysElapsed("2026-08-01", "2026-08-31")).toBe(31);
    expect(daysElapsed("2026-08-01", "2026-09-04")).toBe(31);
    expect(daysElapsed("2026-08-01", "2027-01-01")).toBe(31);
  });

  it("returns 0 before the period starts", () => {
    expect(daysElapsed("2026-08-01", "2026-07-31")).toBe(0);
    expect(daysElapsed("2026-08-01", "2025-12-01")).toBe(0);
  });
});

describe("projectPeriod", () => {
  it("projects the remainder from the trailing mean", () => {
    // 10 days at 100/day, 20 days left → 1,000 actual + 2,000 projected.
    const p = projectPeriod(Array(10).fill(100), 20);
    expect(p.pointCents).toBe(3000);
    expect(p.daysRemaining).toBe(20);
    expect(p.windowDays).toBe(10);
  });

  it("collapses the band to a point when every day is identical", () => {
    // No observed volatility means no honest basis for a range.
    const p = projectPeriod(Array(10).fill(100), 20);
    expect(p.lowCents).toBe(3000);
    expect(p.highCents).toBe(3000);
  });

  it("widens the band when days are volatile", () => {
    const steady = projectPeriod([100, 100, 100, 100], 10);
    const spiky = projectPeriod([0, 200, 0, 200], 10);
    // Same mean, same projection, but the spiky series must admit more uncertainty.
    expect(spiky.pointCents).toBe(steady.pointCents);
    expect(spiky.highCents - spiky.lowCents).toBeGreaterThan(
      steady.highCents - steady.lowCents,
    );
  });

  /**
   * The reason the trailing window exists: revenue arrives in issue-release spikes, so
   * a slow start to the month must not drag the estimate down all month.
   */
  it("ignores days outside the trailing window", () => {
    // Thirty flat days at 10, then four at 100. A whole-period mean would be ~20/day;
    // the trailing window should see 100/day.
    const daily = [...Array(30).fill(10), ...Array(4).fill(100)];
    const p = projectPeriod(daily, 10, 4);
    expect(p.windowDays).toBe(4);
    // 300 + 400 actual = 700, plus 100 × 10 remaining.
    expect(p.pointCents).toBe(1700);
  });

  it("never projects the low bound below what is already banked", () => {
    // A collapsing trend must not imply revenue can be un-earned.
    const p = projectPeriod([1000, 0, 0, 0], 20);
    expect(p.lowCents).toBeGreaterThanOrEqual(1000);
  });

  it("returns the actual, flagged as such, once the period is complete", () => {
    const p = projectPeriod([100, 200, 300], 0);
    expect(p.pointCents).toBe(600);
    expect(p.lowCents).toBe(600);
    expect(p.highCents).toBe(600);
    expect(p.method).toMatch(/complete/i);
  });

  it("does not invent a projection with no observed days", () => {
    const p = projectPeriod([], 30);
    expect(p.pointCents).toBe(0);
    expect(p.windowDays).toBe(0);
    expect(p.method).toMatch(/nothing to project/i);
  });
});

describe("paceVsTarget", () => {
  it("reads 1.0 when exactly on pace", () => {
    // Half the month gone, half the target banked.
    expect(paceVsTarget(500, 1000, 0.5)).toBeCloseTo(1, 10);
  });

  it("reads above 1 when ahead and below when behind", () => {
    expect(paceVsTarget(750, 1000, 0.5)).toBeCloseTo(1.5, 10);
    expect(paceVsTarget(250, 1000, 0.5)).toBeCloseTo(0.5, 10);
  });

  /** Null, not 0 — 0 would render as "completely off pace" rather than "unknown". */
  it("returns null when it cannot be measured", () => {
    expect(paceVsTarget(500, 0, 0.5)).toBeNull();
    expect(paceVsTarget(500, 1000, 0)).toBeNull();
    expect(paceVsTarget(500, -100, 0.5)).toBeNull();
  });
});

describe("goal metrics", () => {
  it("declares a unit for every metric, so formatting can never guess", () => {
    // goals.target_amount is cents for money metrics and a count otherwise; this
    // mapping is the only thing preventing an orders target rendering as $12.00.
    for (const id of GOAL_METRIC_IDS) {
      const m = GOAL_METRICS[id];
      expect(m.id).toBe(id);
      expect(["money", "count"]).toContain(m.unit);
      expect(m.column.length).toBeGreaterThan(0);
    }
    expect(GOAL_METRICS.revenue.unit).toBe("money");
    expect(GOAL_METRICS.cm3.unit).toBe("money");
    expect(GOAL_METRICS.orders.unit).toBe("count");
    expect(GOAL_METRICS.new_customers.unit).toBe("count");
  });

  it("validates untrusted metric names from the goals table", () => {
    expect(isGoalMetric("revenue")).toBe(true);
    expect(isGoalMetric("Revenue")).toBe(false);
    expect(isGoalMetric("profit")).toBe(false);
    expect(isGoalMetric(null)).toBe(false);
  });
});

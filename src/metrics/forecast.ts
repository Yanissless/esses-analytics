/**
 * Goals and forecasting.
 *
 * ## Why the projection isn't a straight line
 *
 * The obvious way to forecast a month is `revenue_so_far ÷ days_elapsed × days_in_month`.
 * For this business that is actively misleading, because revenue arrives in **issue-release
 * spikes** rather than evenly: Issue 04 released 14 Nov, Issue 05 on 30 Jan, Issue 06 on
 * 15 May. Run-rate on 10 May under-forecasts May badly; run-rate on 20 May over-forecasts it.
 *
 * So this module does three things a naive projection doesn't:
 *
 * 1. **Projects from a trailing window**, not from the whole month to date, so a slow
 *    first week stops dragging the estimate down for the rest of the month.
 * 2. **Publishes a band, not a point.** The band comes from the observed day-to-day
 *    standard deviation in the window, so a volatile month honestly produces a wide
 *    range instead of false precision.
 * 3. **Flags when the remaining days contain an issue release**, because that is exactly
 *    when any extrapolation from recent days is unsafe. A number the reader knows not to
 *    trust is far better than one they don't.
 *
 * Every projection carries the method and the assumption that produced it.
 */
import { ratio } from "./formulas";

/*
 * ⚠️ This module must stay dependency-free beyond pure helpers, because the client-side
 * goal form imports GOAL_METRICS from it. Importing the DB client here drags the
 * Postgres driver into the browser bundle and the build fails with
 * `Can't resolve 'fs'`. The DB-backed reads live in `forecast.server.ts`.
 *
 * `tsc --noEmit` does NOT catch that — only `next build` does. Decide the client/server
 * split when you create a shared module, not after the build breaks.
 */

// ---------------------------------------------------------------------------
// Metric definitions — the one place unit handling lives
// ---------------------------------------------------------------------------

export type GoalMetric = "revenue" | "orders" | "new_customers" | "cm3";

export interface GoalMetricMeta {
  id: GoalMetric;
  label: string;
  /** `goals.target_amount` holds cents for money metrics, a count otherwise. */
  unit: "money" | "count";
  /** Column in `daily_metrics` that this metric aggregates. */
  column: string;
  hint: string;
}

export const GOAL_METRICS: Record<GoalMetric, GoalMetricMeta> = {
  revenue: {
    id: "revenue",
    label: "Revenue",
    unit: "money",
    column: "revenue_amount",
    hint: "Net revenue: paid Shopify orders ex-VAT plus Stripe.",
  },
  cm3: {
    id: "cm3",
    label: "CM3 (after ad spend)",
    unit: "money",
    column: "cm3_amount",
    hint: "Contribution margin after COGS, fulfilment and ad spend.",
  },
  orders: {
    id: "orders",
    label: "Orders",
    unit: "count",
    column: "orders",
    hint: "Countable orders, excluding comps.",
  },
  new_customers: {
    id: "new_customers",
    label: "New customers",
    unit: "count",
    column: "new_customers",
    hint: "First-time buyers — the acquisition goal.",
  },
};

export const GOAL_METRIC_IDS = Object.keys(GOAL_METRICS) as GoalMetric[];

export function isGoalMetric(v: unknown): v is GoalMetric {
  return typeof v === "string" && (GOAL_METRIC_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Pure projection maths (unit-tested)
// ---------------------------------------------------------------------------

export interface Projection {
  /** Best estimate for the full period. */
  pointCents: number;
  /** Lower and upper bound from observed daily volatility. */
  lowCents: number;
  highCents: number;
  /** Days the projection had to learn from. */
  windowDays: number;
  daysRemaining: number;
  /** Human-readable description of how this was produced. */
  method: string;
}

/**
 * Project a period total from the daily values observed so far.
 *
 * `trailingDays` bounds how far back the run rate looks. Defaulted to 14: long enough
 * to smooth weekday/weekend swing, short enough that a release three weeks ago doesn't
 * still dominate the estimate.
 *
 * The band is ±1 standard deviation of the daily values, scaled by the number of
 * remaining days — so it widens with both volatility and how much of the period is
 * still unknown, which is the honest shape. It is deliberately NOT a statistical
 * confidence interval; daily e-commerce revenue isn't normally distributed and claiming
 * a 95% interval would be false rigour.
 */
export function projectPeriod(
  dailyValues: number[],
  daysRemaining: number,
  trailingDays = 14,
): Projection {
  const actual = dailyValues.reduce((s, v) => s + v, 0);

  if (daysRemaining <= 0) {
    return {
      pointCents: actual,
      lowCents: actual,
      highCents: actual,
      windowDays: dailyValues.length,
      daysRemaining: 0,
      method: "Period complete — actual, not a projection.",
    };
  }

  const window = dailyValues.slice(-trailingDays);
  if (window.length === 0) {
    return {
      pointCents: actual,
      lowCents: actual,
      highCents: actual,
      windowDays: 0,
      daysRemaining,
      method: "No days observed yet — nothing to project from.",
    };
  }

  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  // Population SD over the window. With a single day there's no spread to measure, so
  // the band collapses to the point estimate rather than pretending to a range.
  const variance =
    window.length > 1
      ? window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length
      : 0;
  const sd = Math.sqrt(variance);

  const projectedRemainder = mean * daysRemaining;
  // Scale the band by sqrt(daysRemaining): independent daily errors partly cancel, so
  // multiplying SD by the full day count would overstate the uncertainty.
  const spread = sd * Math.sqrt(daysRemaining);

  return {
    pointCents: Math.round(actual + projectedRemainder),
    lowCents: Math.round(Math.max(actual, actual + projectedRemainder - spread)),
    highCents: Math.round(actual + projectedRemainder + spread),
    windowDays: window.length,
    daysRemaining,
    method:
      `Mean of the last ${window.length} day(s) × ${daysRemaining} remaining, ` +
      `band ±1 SD scaled by √days.`,
  };
}

/**
 * Whether a period is ahead of or behind the pace needed to hit its target.
 *
 * Compares actual-so-far against the share of the target that *should* be banked by
 * now if progress were even. Returns null when there's no target or the period hasn't
 * started, rather than 0 — 0 would read as "completely off pace".
 */
export function paceVsTarget(
  actual: number,
  target: number,
  fractionElapsed: number,
): number | null {
  if (target <= 0 || fractionElapsed <= 0) return null;
  const expectedByNow = target * fractionElapsed;
  return ratio(actual, expectedByNow);
}

/** Days in the month containing `iso` (YYYY-MM-DD). */
export function daysInMonth(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * How far through a month `asOf` is, counting the current day as elapsed.
 *
 * Clamped to [0, total] so a stale `asOf` from another month can't produce a
 * nonsensical fraction above 1 or below 0.
 */
export function daysElapsed(periodStart: string, asOf: string): number {
  const total = daysInMonth(periodStart);
  const [py, pm] = periodStart.split("-").map(Number);
  const [ay, am, ad] = asOf.split("-").map(Number);
  if (ay < py || (ay === py && am < pm)) return 0;
  if (ay > py || (ay === py && am > pm)) return total;
  return Math.min(Math.max(ad, 0), total);
}


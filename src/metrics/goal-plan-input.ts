/**
 * Parsing and validating a goal plan from user input.
 *
 * Pure and shared, because the planner page and the save action must agree exactly. If the
 * preview computed months one way and the action another, you would get a page that shows one
 * plan and saves a different one — a discrepancy nobody would spot until a target looked
 * wrong months later.
 *
 * The page renders its preview straight from search params, so the whole "play with the
 * numbers" loop is a server render with no client state: the URL IS the plan, which means it
 * can be shared, bookmarked and compared side by side in two tabs.
 */

import { releaseWeights, splitAnnualTarget, type MonthlyWeights } from "./goal-planner";

/** Metrics stored in cents. Everything else is a whole count. */
export const MONEY_METRICS = new Set(["revenue", "cm3"]);

export const GOAL_METRIC_OPTIONS = [
  { value: "revenue", label: "Net revenue" },
  { value: "cm3", label: "CM3 (after ad spend)" },
  { value: "orders", label: "Orders" },
  { value: "new_customers", label: "New customers" },
] as const;

export type PlanShape = "release" | "flat";

export interface GoalPlan {
  metric: string;
  /** In the metric's natural unit: dollars for money, whole counts otherwise. */
  annualNatural: number;
  year: number;
  shape: PlanShape;
  releaseMonths: number[];
  releaseDay: number;
  /** Share of the year that arrives regardless of releases, 0-1. */
  baselineShare: number;
}

export type ParseResult =
  | { ok: true; plan: GoalPlan }
  | { ok: false; error: string };

/** Esses ships quarterly on the 15th — Feb, May, Aug, Nov. Used when nothing is supplied. */
export const DEFAULT_RELEASE_MONTHS = [2, 5, 8, 11];
export const DEFAULT_RELEASE_DAY = 15;
export const DEFAULT_BASELINE_SHARE = 0.35;

function num(v: string | undefined | null): number {
  // Strip $ and thousands separators — people paste "250,000" and "$250,000" and both should
  // work rather than silently becoming NaN and then zero.
  const cleaned = String(v ?? "").replace(/[$,\s]/g, "");
  return cleaned === "" ? NaN : Number(cleaned);
}

export function parseGoalPlan(raw: {
  metric?: string;
  annual?: string;
  year?: string;
  shape?: string;
  releases?: string;
  releaseDay?: string;
  baseline?: string;
}): ParseResult {
  const metric = (raw.metric ?? "revenue").trim();
  if (!GOAL_METRIC_OPTIONS.some((o) => o.value === metric)) {
    return { ok: false, error: `Unknown metric: ${metric}` };
  }

  const annualNatural = num(raw.annual);
  if (!Number.isFinite(annualNatural) || annualNatural <= 0) {
    return { ok: false, error: "Annual target must be a positive number." };
  }

  const year = Number(raw.year ?? NaN);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { ok: false, error: "Year must be between 2000 and 2100." };
  }

  const shape: PlanShape = raw.shape === "flat" ? "flat" : "release";

  const releaseMonths = (raw.releases ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);

  if (shape === "release" && releaseMonths.length === 0) {
    return { ok: false, error: "Give at least one release month (1-12) or choose an even split." };
  }

  const releaseDay = Number.isFinite(num(raw.releaseDay))
    ? Math.min(Math.max(Math.round(num(raw.releaseDay)), 1), 28)
    : DEFAULT_RELEASE_DAY;

  const baselineRaw = num(raw.baseline);
  // Accepted as a percentage (35) rather than a fraction, because that is how it is labelled.
  const baselineShare = Number.isFinite(baselineRaw)
    ? Math.min(Math.max(baselineRaw / 100, 0), 1)
    : DEFAULT_BASELINE_SHARE;

  return {
    ok: true,
    plan: { metric, annualNatural, year, shape, releaseMonths, releaseDay, baselineShare },
  };
}

/**
 * The twelve months a plan produces, in storage units.
 *
 * Money is converted to cents HERE and nowhere else, so a plan can never be saved in dollars
 * by one path and cents by another — a mistake that sets a target a hundred times too large
 * and looks entirely plausible on a chart.
 */
export function planMonths(plan: GoalPlan): {
  metric: string;
  isMoney: boolean;
  annualStored: number;
  weights: MonthlyWeights;
  months: Array<{ periodStart: string; target: number }>;
} {
  const isMoney = MONEY_METRICS.has(plan.metric);
  const annualStored = isMoney
    ? Math.round(plan.annualNatural * 100)
    : Math.round(plan.annualNatural);

  const weights: MonthlyWeights =
    plan.shape === "flat"
      ? { weights: new Array(12).fill(1 / 12), method: "flat", reason: "Even twelfths." }
      : releaseWeights(plan.releaseMonths, plan.baselineShare, plan.releaseDay);

  return {
    metric: plan.metric,
    isMoney,
    annualStored,
    weights,
    months: splitAnnualTarget(annualStored, plan.year, weights.weights),
  };
}

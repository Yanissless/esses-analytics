/**
 * Server-only half of forecasting: the reads against `daily_metrics` and `goals`.
 *
 * Split from `forecast.ts` because that module is imported by the client-side goal
 * form. Anything importing drizzle or the DB client from a `"use client"` file pulls
 * the Postgres driver into the browser bundle and the build fails with
 * `Module not found: Can't resolve 'fs'`. Keep this file out of client components.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";
import {
  GOAL_METRICS,
  GOAL_METRIC_IDS,
  daysElapsed,
  daysInMonth,
  paceVsTarget,
  projectPeriod,
  type GoalMetric,
  type Projection,
} from "./forecast";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const num = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------------------
// DB-backed
// ---------------------------------------------------------------------------

export interface GoalProgress {
  periodStart: string;
  metric: GoalMetric;
  label: string;
  unit: "money" | "count";
  targetAmount: number | null;
  actualAmount: number;
  daysElapsed: number;
  daysInPeriod: number;
  /** Actual ÷ target. Null without a target. */
  attainment: number | null;
  /** Actual ÷ what should be banked by now. >1 is ahead of pace. */
  pace: number | null;
  projection: Projection;
  /** Projection ÷ target. Null without a target. */
  projectedAttainment: number | null;
  /**
   * True when an issue is released in the remaining days of the period, which makes
   * any run-rate projection unreliable — releases are this business's biggest revenue
   * spikes.
   */
  releaseAhead: boolean;
  releaseDate: string | null;
}

/**
 * Progress against every configured goal for a period, plus a projection.
 *
 * `asOf` exists so the caller controls "today" — the metrics tables lag live data by
 * whenever the sync last ran, and projecting from a date later than the last synced day
 * would silently treat missing days as zeros and tank the estimate.
 */
export async function getGoalProgress(
  periodStart: string,
  asOf: string,
): Promise<GoalProgress[]> {
  const total = daysInMonth(periodStart);
  const elapsed = daysElapsed(periodStart, asOf);
  const remaining = Math.max(total - elapsed, 0);

  const [targets, series, releases] = await Promise.all([
    rows<{ metric: string; target_amount: number }>(sql`
      SELECT metric, target_amount FROM goals WHERE period_start = ${periodStart}
    `),
    rows<Record<string, unknown>>(sql`
      SELECT date::text AS date, revenue_amount, cm3_amount, orders, new_customers
        FROM daily_metrics
       WHERE channel IS NULL
         AND date >= ${periodStart}
         AND date < (${periodStart}::date + interval '1 month')
         AND date <= ${asOf}
       ORDER BY date
    `),
    // An issue release still to come in this period breaks run-rate projection.
    rows<{ released_on: string }>(sql`
      SELECT min(o.processed_at)::date::text AS released_on
        FROM order_line_items li JOIN orders o ON o.id = li.order_id
       WHERE o.test = false AND o.cancelled_at IS NULL AND o.processed_at IS NOT NULL
         AND lower(li.title) !~ 'pre[ -]?(order|sale)'
         AND (regexp_match(lower(li.title), 'issue\\s*#?\\s*0*([0-9]{1,2})'))[1] IS NOT NULL
       GROUP BY (regexp_match(lower(li.title), 'issue\\s*#?\\s*0*([0-9]{1,2})'))[1]
      HAVING min(o.processed_at)::date > ${asOf}
         AND min(o.processed_at)::date < (${periodStart}::date + interval '1 month')
       ORDER BY 1 LIMIT 1
    `),
  ]);

  const targetByMetric = new Map(targets.map((t) => [t.metric, Number(t.target_amount)]));
  const releaseDate = releases[0]?.released_on ?? null;

  return GOAL_METRIC_IDS.map((metric) => {
    const meta = GOAL_METRICS[metric];
    const daily = series.map((r) => num(r[meta.column]));
    const actual = daily.reduce((s, v) => s + v, 0);
    const target = targetByMetric.get(metric) ?? null;
    const projection = projectPeriod(daily, remaining);

    return {
      periodStart,
      metric,
      label: meta.label,
      unit: meta.unit,
      targetAmount: target,
      actualAmount: actual,
      daysElapsed: elapsed,
      daysInPeriod: total,
      attainment: target != null ? ratio(actual, target) : null,
      pace: target != null ? paceVsTarget(actual, target, elapsed / total) : null,
      projection,
      projectedAttainment: target != null ? ratio(projection.pointCents, target) : null,
      releaseAhead: releaseDate != null,
      releaseDate,
    };
  });
}

export interface MonthlyActual {
  month: string;
  revenueCents: number;
  cm3Cents: number;
  orders: number;
  newCustomers: number;
  adSpendCents: number;
  /** Complete months only — the current one is partial and not comparable. */
  isComplete: boolean;
}

/**
 * Monthly actuals, with the in-progress month flagged.
 *
 * The flag matters more than it looks: a partial current month plotted alongside
 * complete ones reads as a collapse in revenue, which is the single most common way a
 * dashboard like this misleads.
 */
export async function getMonthlyActuals(asOf: string): Promise<MonthlyActual[]> {
  const data = await rows<Record<string, unknown>>(sql`
    SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
           date_trunc('month', date)::date AS period_start,
           COALESCE(sum(revenue_amount), 0) AS revenue,
           COALESCE(sum(cm3_amount), 0) AS cm3,
           COALESCE(sum(orders), 0) AS orders,
           COALESCE(sum(new_customers), 0) AS new_customers,
           COALESCE(sum(ad_spend_amount), 0) AS ad_spend
      FROM daily_metrics
     WHERE channel IS NULL AND date <= ${asOf}
     GROUP BY 1, 2
     ORDER BY 2
  `);

  const currentMonth = asOf.slice(0, 7);
  return data.map((r) => ({
    month: String(r.month),
    revenueCents: num(r.revenue),
    cm3Cents: num(r.cm3),
    orders: num(r.orders),
    newCustomers: num(r.new_customers),
    adSpendCents: num(r.ad_spend),
    isComplete: String(r.month) < currentMonth,
  }));
}

/** The last day `daily_metrics` actually holds — the honest "today" for forecasting. */
export async function getLastMetricsDate(): Promise<string | null> {
  const [r] = await rows<{ d: string | null }>(sql`
    SELECT max(date)::text AS d FROM daily_metrics WHERE channel IS NULL
  `);
  return r?.d ?? null;
}

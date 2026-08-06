import {
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { currency, money, pk } from "./_shared";

/**
 * Precomputed daily rollup (Section 6/9). The dashboard reads from HERE, never
 * from raw rows, so page loads are fast. Grain is (date, channel); `channel`
 * NULL = blended/all-channels. Recomputed by the metrics engine (Phase 6).
 *
 * Ratios are stored as double precision; money as cents + currency. Contribution
 * margin tiers and the COGS-coverage gap (Section 5) are materialised here so
 * the Profit view can show a real number with the gap called out.
 */
export const dailyMetrics = pgTable(
  "daily_metrics",
  {
    id: pk(),
    date: date("date").notNull(),
    channel: text("channel"), // NULL = blended

    currency: currency().notNull().default("USD"),

    // Revenue & orders
    revenueAmount: money("revenue_amount").notNull().default(0),
    newCustomerRevenueAmount: money("new_customer_revenue_amount")
      .notNull()
      .default(0),
    orders: integer("orders").notNull().default(0),
    newCustomers: integer("new_customers").notNull().default(0),
    returningCustomers: integer("returning_customers").notNull().default(0),

    // Cost components
    adSpendAmount: money("ad_spend_amount").notNull().default(0),
    cogsAmount: money("cogs_amount").notNull().default(0),
    shippingAmount: money("shipping_amount").notNull().default(0),
    processingAmount: money("processing_amount").notNull().default(0),
    discountsAmount: money("discounts_amount").notNull().default(0),
    refundsAmount: money("refunds_amount").notNull().default(0),

    // Contribution margin tiers (Section 7)
    cm1Amount: money("cm1_amount").notNull().default(0),
    cm2Amount: money("cm2_amount").notNull().default(0),
    cm3Amount: money("cm3_amount").notNull().default(0),

    // Efficiency ratios (Section 7)
    mer: doublePrecision("mer"),
    amer: doublePrecision("amer"),
    roas: doublePrecision("roas"),
    cac: doublePrecision("cac"),
    aov: doublePrecision("aov"),

    // COGS coverage gap (Section 5) — never let margin be silently wrong.
    unknownCogsLineCount: integer("unknown_cogs_line_count")
      .notNull()
      .default(0),
    unknownCogsOrderCount: integer("unknown_cogs_order_count")
      .notNull()
      .default(0),

    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT so the blended row (channel = NULL) is unique per day
    // and ON CONFLICT (date, channel) upserts it correctly.
    unique("daily_metrics_date_channel_unique")
      .on(t.date, t.channel)
      .nullsNotDistinct(),
    index("daily_metrics_date_idx").on(t.date),
  ],
);

export type DailyMetric = typeof dailyMetrics.$inferSelect;
export type NewDailyMetric = typeof dailyMetrics.$inferInsert;

/**
 * Monthly targets, one row per (period, metric). Set by hand — these are business
 * goals, not derived from data.
 *
 * ⚠️ `target_amount` is a plain integer whose UNIT depends on the metric: cents for
 * money metrics (revenue, cm3), a whole count for the others (orders,
 * new_customers). Keeping both in one column keeps the table simple, but a caller
 * MUST consult `metric` before formatting — `GOAL_METRICS` in metrics/forecast.ts is
 * the single place that mapping lives.
 *
 * `period_start` is always the first day of a month. Month is the grain because
 * that's how the business plans, and shorter periods are too noisy for a magazine
 * whose revenue arrives in issue-release spikes.
 */
export const goals = pgTable(
  "goals",
  {
    id: pk(),
    periodStart: date("period_start").notNull(),
    /** 'revenue' | 'orders' | 'new_customers' | 'cm3' — see GOAL_METRICS. */
    metric: text("metric").notNull(),
    targetAmount: integer("target_amount").notNull(),
    currency: currency().notNull().default("USD"),
    note: text("note"),
  },
  (t) => [
    unique("goals_period_metric_unique").on(t.periodStart, t.metric),
    index("goals_period_idx").on(t.periodStart),
  ],
);

export type Goal = typeof goals.$inferSelect;

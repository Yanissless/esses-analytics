import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, money, pk } from "./_shared";

/**
 * Per-order costed profit — a DERIVED table, rebuilt by the metrics job.
 *
 * Resolving COGS per line item means a correlated lookup for the cost effective on
 * the order date, per origin, with a variant fallback. That's acceptable once, but
 * the Profit page needed it four times per load (waterfall, per-product, worst
 * orders, quality) over ~9,400 line items and timed out. Materialising it once
 * makes every profit read a plain aggregate.
 *
 * It also removes a correctness hazard: the same cost logic was duplicated across
 * the rollup, the international view and the profit page, so the three could drift
 * apart. Now they all read this.
 *
 * Never edited by hand — `rebuildOrderProfit()` truncates and repopulates.
 */
export const orderProfit = pgTable(
  "order_profit",
  {
    id: pk(),
    orderId: uuid("order_id").notNull(),
    orderNumber: text("order_number"),
    processedOn: date("processed_on"),
    country: text("country"),
    /** 'paid' | 'prepaid_delivery' | 'comp' — see rollup notes. */
    revenueClass: text("revenue_class").notNull(),
    orderType: text("order_type"),
    origin: text("origin"),
    zone: text("zone"),

    currency: currency().notNull().default("USD"),
    grossAmount: money("gross_amount").notNull().default(0),
    netExVatAmount: money("net_ex_vat_amount").notNull().default(0),
    refundsAmount: money("refunds_amount").notNull().default(0),
    discountsAmount: money("discounts_amount").notNull().default(0),

    units: integer("units").notNull().default(0),
    cogsAmount: money("cogs_amount").notNull().default(0),
    uncostedUnits: integer("uncosted_units").notNull().default(0),

    shipCostAmount: money("ship_cost_amount").notNull().default(0),
    shipChargedAmount: money("ship_charged_amount").notNull().default(0),
    dutiesAmount: money("duties_amount").notNull().default(0),
    otherFulfilAmount: money("other_fulfil_amount").notNull().default(0),
    processingAmount: money("processing_amount").notNull().default(0),
    /** 'actual' | 'rate_rule' | 'zone_estimate' — how shipping cost was derived. */
    shipBasis: text("ship_basis"),

    cm1Amount: money("cm1_amount").notNull().default(0),
    cm2Amount: money("cm2_amount").notNull().default(0),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_profit_order_unique").on(t.orderId),
    index("order_profit_date_idx").on(t.processedOn),
    index("order_profit_class_idx").on(t.revenueClass),
    index("order_profit_cm2_idx").on(t.cm2Amount),
    index("order_profit_country_idx").on(t.country),
  ],
);

export type OrderProfitRow = typeof orderProfit.$inferSelect;

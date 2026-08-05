import {
  boolean,
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { currency, money, pk, timestamps } from "./_shared";

/**
 * Per-market configuration — the digital version of the international pricing
 * model (VAT, FX, uplift, shipping zone, fulfilment routing).
 *
 * International prices are tax-INCLUSIVE, so net revenue = gross / (1 + VAT).
 * The print rate applies where the magazine qualifies for a reduced/zero rate;
 * some markets (DK, NO, AU, JP, NZ, SG) have no print reduction, which is what
 * crushes margin there.
 *
 * `fulfillment_origin` is the routing rule: which facility serves this market
 * (e.g. UK printer park serves UK/EU, US serves North America). Cost lookups use
 * it to pick the right per-unit cost from `product_costs`.
 */
export const marketConfig = pgTable(
  "market_config",
  {
    id: pk(),
    countryCode: text("country_code").notNull(), // ISO-3166 alpha-2
    marketName: text("market_name").notNull(),
    currency: currency().notNull(),
    /** Price uplift applied over the USD base price, as a fraction (0.20 = 20%). */
    upliftPct: doublePrecision("uplift_pct").notNull().default(0),
    /** Reduced/zero VAT rate for printed press, as a fraction (0.09 = 9%). */
    printVatPct: doublePrecision("print_vat_pct").notNull().default(0),
    /** Standard VAT rate, as a fraction. */
    stdVatPct: doublePrecision("std_vat_pct").notNull().default(0),
    /** Which VAT rate actually applies to our supply. */
    vatBasis: text("vat_basis").notNull().default("print"), // 'print' | 'standard'
    /** Shipping cost zone — joins to cost_assumptions.zone. */
    shippingZone: text("shipping_zone").notNull().default("row"),
    /** Facility that fulfils this market: 'US' | 'UK'. */
    fulfillmentOrigin: text("fulfillment_origin").notNull().default("US"),
    /** Local currency units per 1 USD (for reference/reporting). */
    fxPerUsd: doublePrecision("fx_per_usd"),
    fxAsOf: date("fx_as_of"),
    active: boolean("active").notNull().default(true),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("market_config_country_unique").on(t.countryCode),
    index("market_config_zone_idx").on(t.shippingZone),
  ],
);

/**
 * Time-versioned variable-cost assumptions per shipping zone — everything between
 * revenue and contribution margin that isn't the printed unit itself.
 *
 * Sourced from the e-commerce profit calculators (US distribution and DieKuere
 * Europe fulfilment). These are PLACEHOLDERS pending refresh; `source` and `note`
 * record where each figure came from so nobody mistakes them for verified costs.
 */
export const costAssumptions = pgTable(
  "cost_assumptions",
  {
    id: pk(),
    /** Shipping/cost zone: 'us' | 'uk' | 'eu' | 'row' — joins market_config.shipping_zone. */
    zone: text("zone").notNull(),
    effectiveDate: date("effective_date").notNull(),
    currency: currency().notNull().default("USD"),

    /** Outbound shipping cost we pay per shipment. */
    shipCostAmount: money("ship_cost_amount").notNull().default(0),
    /** Inbound freight, duties, supplier→warehouse, per unit. */
    freightPerUnitAmount: money("freight_per_unit_amount").notNull().default(0),
    /** Packaging and inserts per order. */
    packagingAmount: money("packaging_amount").notNull().default(0),
    /** 3PL pick-and-pack per order. */
    pickPackAmount: money("pick_pack_amount").notNull().default(0),
    /** Payment processing as a fraction of gross (0.029 = 2.9%). */
    processingPct: doublePrecision("processing_pct").notNull().default(0),
    /** Expected return rate as a fraction, and the cost to process one. */
    returnRatePct: doublePrecision("return_rate_pct").notNull().default(0),
    returnCostAmount: money("return_cost_amount").notNull().default(0),

    source: text("source"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("cost_assumptions_zone_date_unique").on(t.zone, t.effectiveDate),
    index("cost_assumptions_zone_idx").on(t.zone),
  ],
);

/**
 * Global margin/pricing settings (single active row, time-versioned).
 * Mirrors the Assumptions tab of the international pricing model.
 */
export const marginSettings = pgTable(
  "margin_settings",
  {
    id: pk(),
    effectiveDate: date("effective_date").notNull(),
    /** Target contribution margin as a fraction (0.20 = 20%). */
    targetMarginPct: doublePrecision("target_margin_pct").notNull().default(0.2),
    baseQuarterlyAmount: money("base_quarterly_amount").notNull().default(3000),
    baseAnnualAmount: money("base_annual_amount").notNull().default(10000),
    issuesPerQuarter: doublePrecision("issues_per_quarter").notNull().default(1),
    issuesPerYear: doublePrecision("issues_per_year").notNull().default(4),
    /**
     * Which revenue classes bear cost when margin is computed:
     * 'paid_only' | 'exclude_comps' | 'all_classes'. See metrics/margin-boundary.ts.
     *
     * A lens, not a restatement — revenue is identical under all three because comps
     * and prepaid deliveries collect $0, so only which COSTS are charged changes.
     * Nothing is rebuilt when it changes, which is what makes it safe to flip live.
     */
    marginBoundary: text("margin_boundary").notNull().default("paid_only"),
    currency: currency().notNull().default("USD"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [uniqueIndex("margin_settings_date_unique").on(t.effectiveDate)],
);

export type MarketConfig = typeof marketConfig.$inferSelect;
export type CostAssumption = typeof costAssumptions.$inferSelect;
export type MarginSettings = typeof marginSettings.$inferSelect;

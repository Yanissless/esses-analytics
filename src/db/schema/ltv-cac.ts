import { date, doublePrecision, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { currency, money, pk, timestamps } from "./_shared";

/**
 * LTV:CAC assumptions, per tier and route to market (Section 7 methodology note,
 * Ojus Jain, 10 Aug 2026 — "How LTV and LTV:CAC Are Calculated").
 *
 * ## Why this is an assumptions table, not a live-data query
 *
 * The formula itself — survival-weighted, discounted, contribution-based NPV — is
 * pure and lives in `metrics/ltv-cac.ts`, fully unit-tested against the
 * methodology doc's own worked examples. What is NOT safe to derive live is which
 * real Skio/Stripe plan rows belong to which of these three tiers: "premium"
 * ($275) does not exist in the live plan data at all yet, and mapping "digital"
 * vs "print+digital" onto actual plan names is a judgement call nobody has
 * confirmed. Guessing that mapping would produce a plausible-but-wrong r1/r2 for
 * exactly the number this whole feature exists to get right — worse than asking.
 * So retention (`r1`, `r2`), price and CAC are entered here, effective-dated
 * exactly like `product_costs`, and the app computes LTV, LTV:CAC and payback
 * live from whatever is entered. Once a tier↔plan mapping is confirmed, `r1`/`r2`
 * can be swapped for a query against `renewal-counting.ts` without touching the
 * formula.
 *
 * `route` separates subscribers acquired via paid acquisition ("bought") from
 * subscribers who upgraded from an existing tier ("upgraded") — the doc is
 * explicit that averaging these hides the decision (Section 8, rule 3).
 */
export const ltvCacAssumptions = pgTable(
  "ltv_cac_assumptions",
  {
    id: pk(),
    /** Stable key, e.g. 'digital', 'print_digital', 'premium'. Free text — new
     *  tiers (or a repriced variant of one) are just a new row. */
    tier: text("tier").notNull(),
    /** Display label, e.g. "Print+digital $100". */
    tierLabel: text("tier_label").notNull(),
    /** 'bought' (paid acquisition) or 'upgraded' (existing subscriber moved up). */
    route: text("route").notNull(),
    effectiveDate: date("effective_date").notNull(),
    currency: currency().notNull().default("USD"),

    /** Annual list price before any discount. */
    listPriceCents: money("list_price_cents").notNull().default(0),
    /** Year-1-only introductory discount, as a fraction (0.10 = 10%). Renewals
     *  pay full list price — see the methodology note Section 2. */
    introDiscountPct: doublePrecision("intro_discount_pct").notNull().default(0),
    /** Payment processing, as a fraction of realised price. */
    processingPct: doublePrecision("processing_pct").notNull().default(0),
    /**
     * COGS charged EVERY billing period — print, postage, packaging, creative.
     * Zero for a digital-only tier. "Every period" matters: for an annual plan
     * that is a year's worth (4 issues); for a quarterly plan it is one cycle's
     * worth (1 issue), not four. Mixing the two up makes a quarterly tier's
     * contribution silently negative — see `cycleMonths` below.
     */
    annualCogsCents: money("annual_cogs_cents").notNull().default(0),
    /**
     * How many months one billing period covers — 12 for an annual plan, 3 for
     * quarterly. Every "year" in this table's other fields (r1, r2, the LTV
     * formula's t=1..T, the payback ×12) is actually a PERIOD, and periods are
     * only 12 months long for an annual plan. `computeLtv` uses this to convert
     * period index into real elapsed time for discounting, and to scale the
     * payback multiplier — get it wrong and a quarterly tier's numbers are
     * wrong by roughly 4x, silently.
     */
    cycleMonths: integer("cycle_months").notNull().default(12),

    /** r1 — first-renewal survival rate for this tier's own billing cycle, as a
     *  fraction (period 1 → period 2, NOT necessarily year 1 → year 2). */
    r1: doublePrecision("r1").notNull(),
    /** r2 — steady-state retention rate from the second renewal onward, as a
     *  fraction. Applied every period past the second (S(t) = r1 × r2^(t-2)). */
    r2: doublePrecision("r2").notNull(),
    /** Annual discount rate for NPV, as a fraction (0.15 = 15%). */
    discountRatePct: doublePrecision("discount_rate_pct").notNull().default(0.15),
    /** T — years of explicit cash flow before the model stops (default 3),
     *  regardless of `cycleMonths`: 3 years is 3 periods for an annual tier and
     *  12 for a quarterly one, so different-cadence tiers stay comparable. */
    horizonYears: integer("horizon_years").notNull().default(3),

    /** Fully-loaded cost to acquire (or upgrade) one subscriber on this tier via
     *  this route. A single all-in figure, same as the methodology doc reports
     *  it — see the doc's Section 8 note on why media-only CAC is excluded. */
    cacCents: money("cac_cents").notNull().default(0),
    /** Share of the CURRENT base this tier represents, as a fraction — the
     *  weight used only for the optional portfolio/blended LTV (Section 10).
     *  Null when not supplied; the blended figure is skipped rather than
     *  guessed. */
    baseSharePct: doublePrecision("base_share_pct"),
    /** LTV:CAC target ratio to test against (default 3, the FTI/INMA convention
     *  the doc cites in Section 8). */
    targetRatio: doublePrecision("target_ratio").notNull().default(3),

    source: text("source"),
    note: text("note"),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ltv_cac_tier_route_date_unique").on(t.tier, t.route, t.effectiveDate),
  ],
);

export type LtvCacAssumption = typeof ltvCacAssumptions.$inferSelect;
export type NewLtvCacAssumption = typeof ltvCacAssumptions.$inferInsert;

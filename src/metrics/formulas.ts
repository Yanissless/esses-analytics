/**
 * Section 7 metric formulas — pure functions, no DB, fully unit-tested.
 *
 * These live apart from the SQL rollup for one reason: a subtle arithmetic error
 * here would silently produce plausible-but-wrong numbers on every dashboard.
 * Keeping them pure makes each one checkable by hand.
 *
 * Convention on missing values: a ratio whose denominator is zero returns **null**,
 * not 0 and not Infinity. Zero would read as "terrible performance" and Infinity
 * would poison averages — null means "not measurable yet", which is the truth when
 * there's no ad spend or no customers. Callers render null as "—".
 *
 * All money arguments are integer MINOR UNITS (cents); ratios are fractions
 * (0.34 = 34%), and percentages are only formatted at the edges.
 */

/** Safe division: null when the denominator is 0 or either side is non-finite. */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * MER — Marketing Efficiency Ratio = total revenue ÷ total ad spend (blended).
 * The business-level health metric: "for every $1 of ads, how many $ of revenue".
 */
export function mer(totalRevenueCents: number, totalAdSpendCents: number): number | null {
  return ratio(totalRevenueCents, totalAdSpendCents);
}

/**
 * aMER — acquisition MER = NEW-customer revenue ÷ total ad spend.
 * Isolates whether spend is actually acquiring customers rather than riding on
 * repeat/organic revenue. This is the number that catches a channel that looks
 * fine on blended MER while acquiring nobody.
 */
export function amer(newCustomerRevenueCents: number, totalAdSpendCents: number): number | null {
  return ratio(newCustomerRevenueCents, totalAdSpendCents);
}

/**
 * ROAS — revenue attributed to a channel ÷ that channel's spend.
 * Tactical only: useful for comparing ads, misleading as a business metric
 * because attribution is a modelling choice. Surface it, don't lead with it.
 */
export function roas(attributedRevenueCents: number, channelSpendCents: number): number | null {
  return ratio(attributedRevenueCents, channelSpendCents);
}

/**
 * CAC — ad spend ÷ new customers acquired. Reported blended and per channel.
 *
 * Returns null when there is no ad spend. Arithmetically that case is $0, but on a
 * dashboard "CAC $0.00" reads as "customers are free" when the truth is "no paid
 * acquisition is being measured" — and it sits next to MER, which is already null
 * for the same reason. Consistency here beats a technically-true zero.
 */
export function cac(adSpendCents: number, newCustomers: number): number | null {
  if (adSpendCents === 0) return null;
  return ratio(adSpendCents, newCustomers);
}

/**
 * CAC payback period in MONTHS = CAC ÷ (monthly revenue per customer × gross margin).
 *
 * Returns null when there's no CAC to recover or no monthly contribution — an
 * unrecoverable CAC is *not* "0 months", which would read as instant payback.
 */
export function cacPaybackMonths(
  cacCents: number | null,
  monthlyRevenuePerCustomerCents: number,
  grossMarginPct: number,
): number | null {
  if (cacCents == null || cacCents <= 0) return null;
  const monthlyContribution = monthlyRevenuePerCustomerCents * grossMarginPct;
  return ratio(cacCents, monthlyContribution);
}

export interface ContributionMarginInput {
  /** Net revenue (after refunds, ex-VAT where applicable). */
  netRevenueCents: number;
  cogsCents: number;
  /** Variable fulfilment costs: shipping, duties, packaging, pick/pack, returns. */
  fulfillmentCents: number;
  /** Payment processing fees. */
  processingCents: number;
  /** Discounts, where not already deducted from net revenue. */
  discountsCents: number;
  /** Marketing/ad spend allocated to this scope. */
  adSpendCents: number;
}

export interface ContributionMargin {
  cm1Cents: number;
  cm2Cents: number;
  cm3Cents: number;
  cm1Pct: number | null;
  cm2Pct: number | null;
  cm3Pct: number | null;
}

/**
 * Contribution margin tiers (Section 7):
 *   CM1 = revenue − COGS
 *   CM2 = CM1 − variable fulfilment costs (shipping, processing, discounts, returns)
 *   CM3 = CM2 − marketing spend   ("NCCM" when scoped to first orders)
 */
export function contributionMargin(input: ContributionMarginInput): ContributionMargin {
  const cm1 = input.netRevenueCents - input.cogsCents;
  const cm2 = cm1 - input.fulfillmentCents - input.processingCents - input.discountsCents;
  const cm3 = cm2 - input.adSpendCents;
  return {
    cm1Cents: cm1,
    cm2Cents: cm2,
    cm3Cents: cm3,
    cm1Pct: ratio(cm1, input.netRevenueCents),
    cm2Pct: ratio(cm2, input.netRevenueCents),
    cm3Pct: ratio(cm3, input.netRevenueCents),
  };
}

/** AOV — average order value over PAID orders only. */
export function aov(grossRevenueCents: number, paidOrderCount: number): number | null {
  return ratio(grossRevenueCents, paidOrderCount);
}

// ---------------------------------------------------------------------------
// LTV — three variants, per Section 7
// ---------------------------------------------------------------------------

/**
 * Historical (realised) LTV: value actually collected per customer to date,
 * summed across every revenue source. `basis` lets the caller compute it on
 * revenue or on contribution margin.
 */
export function historicalLtv(totalValueCents: number, customerCount: number): number | null {
  return ratio(totalValueCents, customerCount);
}

/**
 * 12-month LTV — the primary number. Same as historical but windowed to the first
 * 12 months from acquisition, which is what current DTC practice favours over
 * long-run projections given churn.
 */
export function twelveMonthLtv(
  valueInFirst12MonthsCents: number,
  cohortCustomerCount: number,
): number | null {
  return ratio(valueInFirst12MonthsCents, cohortCustomerCount);
}

/**
 * Predictive subscription LTV = MRR × expected remaining lifespan, where lifespan
 * is implied by the cohort's observed monthly churn (1 / churn).
 *
 * Zero churn would imply infinite life, which is not a number to put on a
 * dashboard — it's capped, and the cap is explicit rather than hidden.
 */
export function predictiveSubscriptionLtv(
  mrrCents: number,
  monthlyChurnRate: number,
  maxMonths = 60,
): number | null {
  if (!Number.isFinite(mrrCents) || mrrCents < 0) return null;
  if (!Number.isFinite(monthlyChurnRate) || monthlyChurnRate < 0) return null;
  const lifespanMonths = monthlyChurnRate === 0 ? maxMonths : Math.min(1 / monthlyChurnRate, maxMonths);
  return Math.round(mrrCents * lifespanMonths);
}

/** Monthly churn = subscribers lost in the month ÷ subscribers at its start. */
export function monthlyChurnRate(churnedCount: number, startingCount: number): number | null {
  return ratio(churnedCount, startingCount);
}

/** Retention = 1 − churn. Null when churn isn't measurable. */
export function retentionRate(churn: number | null): number | null {
  return churn == null ? null : 1 - churn;
}

/**
 * Blended breakeven MER = 1 ÷ contribution-margin rate.
 *
 * The MER below which spending loses money. If CM2 is 34% of revenue, you break
 * even at MER ≈ 2.94.
 */
export function breakevenMer(contributionMarginPct: number | null): number | null {
  if (contributionMarginPct == null || contributionMarginPct <= 0) return null;
  return 1 / contributionMarginPct;
}

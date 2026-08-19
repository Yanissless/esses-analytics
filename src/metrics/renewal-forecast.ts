/**
 * Renewal forecast — what the existing subscriber book is scheduled to bill, and when.
 *
 * Sam asked for this off Skio's next-billing dates. Those are already stored on
 * `subscription_meta.next_billing_at`, so no new connector is needed.
 *
 * ## The charge is NOT the MRR
 *
 * `mrr_amount` is normalised to a month — see the note in `connectors/skio/ingest.ts`, where an
 * annual plan that bills yearly but delivers quarterly has to be divided out. So the amount
 * actually charged on a renewal date is:
 *
 *     charge = mrr_amount x billing_interval_count
 *
 * Summing `mrr_amount` instead would understate the November wave by 4.6x on this book. That
 * is the single easiest mistake to make here and it produces a plausible-looking number.
 *
 * ## Two things this module refuses to hide
 *
 * **1. The book is concentrated in one month.** 1,784 of 1,785 active subscriptions renew in
 * November 2026 — the subscription cycle is pinned to the issue release calendar, and 15 Nov is
 * a release date. A forecast that spread this smoothly would misrepresent both the cash timing
 * and the risk: one bad renewal month is the whole year.
 *
 * **2. The two cadences imply very different per-issue prices**, and that needs checking before
 * anyone quotes the total:
 *
 *     quarterly (interval 3)   893 subs   avg MRR $10.43  ->  ~$31.29 per renewal
 *     annual    (interval 12)  892 subs   avg MRR  $2.19  ->  ~$26.28 per renewal
 *
 * Annualised that is ~$125/yr against ~$26/yr for what should be a similar product. Either the
 * plans genuinely differ that much, or one cadence's MRR normalisation is wrong. `priceWarning`
 * carries this so the page states it rather than printing a confident total over a suspect
 * input.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { renewalChargeCents } from "./plan-prices";

/** Ratio between per-issue prices beyond which the two cadences are worth questioning. */
export const PRICE_DIVERGENCE_FACTOR = 2;

/**
 * Minimum subscriptions in a cadence before its price is compared with another's.
 *
 * Without it, the check fired on a SINGLE $5/month Stripe subscription against 150 quarterly
 * ones and declared a 2x pricing anomaly. One subscription cannot establish that a cadence is
 * mispriced — it establishes that one customer is on an unusual plan, which is not the same
 * claim and needs no warning. Same floor as the other graded surfaces in this codebase.
 */
export const MIN_SUBS_FOR_DIVERGENCE = 20;

export interface RenewalMonth {
  /** YYYY-MM. */
  month: string;
  subscriptions: number;
  /** mrr x billing_interval_count, summed. */
  expectedChargeCents: number;
  /** Sum of monthly-normalised MRR. Kept only so the page can show why it differs. */
  mrrSumCents: number;
}

export interface CadenceBreakdown {
  /** Which subscription system these came from. Cadences are only comparable within one. */
  source: string;
  intervalCount: number;
  subscriptions: number;
  avgMrrCents: number;
  /** avgMrr x intervalCount — what one renewal bills. */
  avgChargeCents: number;
  /** Annualised equivalent, for comparing cadences on a common footing. */
  annualisedCents: number;
}

export interface RenewalForecast {
  months: RenewalMonth[];
  cadences: CadenceBreakdown[];
  totalSubscriptions: number;
  totalExpectedCents: number;
  /** Month holding the largest share, and that share. Null when there is nothing scheduled. */
  concentration: { month: string; share: number } | null;
  /**
   * Set when the cadences' annualised prices diverge by more than
   * PRICE_DIVERGENCE_FACTOR. Null when they agree.
   */
  priceWarning: string | null;
  /** Subscriptions whose charge was arithmetic rather than a known plan price. */
  derivedCount: number;
  /** Subscriptions with no usable price at all. Excluded from the total. */
  unknownCount: number;
  /**
   * Split by subscription system, so the Skio-to-Craft migration is visible in the same place
   * as the forecast it changes. Craft subscriptions bill through Stripe.
   */
  sources: Array<{ source: string; subscriptions: number; expectedChargeCents: number }>;
}

/** Flags cadences whose annualised price disagrees enough to distrust the total. */
export function checkPriceDivergence(cadences: CadenceBreakdown[]): string | null {
  const usable = cadences.filter(
    (c) => c.subscriptions >= MIN_SUBS_FOR_DIVERGENCE && c.annualisedCents > 0,
  );
  if (usable.length < 2) return null;

  const lo = usable.reduce((a, b) => (b.annualisedCents < a.annualisedCents ? b : a));
  const hi = usable.reduce((a, b) => (b.annualisedCents > a.annualisedCents ? b : a));
  if (hi.annualisedCents < lo.annualisedCents * PRICE_DIVERGENCE_FACTOR) return null;

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  return (
    `Cadences imply very different annual prices: every-${hi.intervalCount}-month subs at ` +
    `${money(hi.annualisedCents)}/yr against every-${lo.intervalCount}-month at ` +
    `${money(lo.annualisedCents)}/yr, a ${(hi.annualisedCents / lo.annualisedCents).toFixed(1)}x ` +
    `gap. Either the plans really differ that much or one cadence's MRR normalisation is wrong. ` +
    `Verify against Skio's actual plan prices before quoting the total.`
  );
}

export async function getRenewalForecast(monthsAhead = 12): Promise<RenewalForecast> {
  // One row per subscription rather than a SQL GROUP BY, because the charge depends on the
  // PLAN, and a plan price is a hand-maintained business fact rather than something the query
  // can derive. See metrics/plan-prices.ts for why that had to change.
  const subs = await db.execute<{
    month: string;
    source: string;
    plan_name: string | null;
    mrr_amount: number;
    interval_months: number | null;
  }>(sql`
    -- Both subscription systems, because the migration off Skio runs for years and a
    -- forecast covering only one would describe a quietly shrinking share of the book while
    -- looking complete. 220 active Stripe subscriptions were already invisible to it.
    SELECT to_char(next_billing_at, 'YYYY-MM') AS month,
           'skio'                              AS source,
           selling_plan_name                   AS plan_name,
           mrr_amount,
           billing_interval_count              AS interval_months
      FROM subscription_meta
     WHERE status = 'active'
       AND next_billing_at IS NOT NULL
       AND next_billing_at >= now()
       AND next_billing_at < now() + (${monthsAhead} || ' months')::interval

    UNION ALL

    SELECT to_char(current_period_end, 'YYYY-MM') AS month,
           'stripe'                               AS source,
           plan_nickname                          AS plan_name,
           mrr_amount,
           -- Stripe states its interval in the unit, not always months. A yearly plan with
           -- interval_count 1 renews every 12 months; reading the count alone would treat it
           -- as monthly and overstate the year's renewals twelvefold.
           CASE lower(COALESCE(interval, 'month'))
             WHEN 'year'  THEN COALESCE(interval_count, 1) * 12
             WHEN 'week'  THEN GREATEST(1, (COALESCE(interval_count, 1) / 4))
             WHEN 'day'   THEN GREATEST(1, (COALESCE(interval_count, 1) / 30))
             ELSE COALESCE(interval_count, 1)
           END                                    AS interval_months
      FROM stripe_subscriptions
     WHERE status = 'active'
       AND current_period_end IS NOT NULL
       AND current_period_end >= now()
       AND current_period_end < now() + (${monthsAhead} || ' months')::interval
  `);

  const byMonth = new Map<string, RenewalMonth>();
  const bySource = new Map<string, { subs: number; chargeCents: number }>();
  // Keyed by source AND cadence, so the divergence check below never compares across systems.
  const cadenceAgg = new Map<string, { subs: number; mrrTotal: number; chargeTotal: number }>();
  let derivedCount = 0;
  let unknownCount = 0;

  for (const r of subs) {
    const mrr = Number(r.mrr_amount) || 0;
    const months = Number(r.interval_months) || 1;
    const charge = renewalChargeCents({
      sellingPlanName: r.plan_name,
      mrrCents: mrr,
      billingIntervalCount: months,
    });
    if (charge.source === "derived-from-mrr") derivedCount += 1;
    if (charge.source === "unknown") unknownCount += 1;

    const m = byMonth.get(r.month) ?? {
      month: r.month,
      subscriptions: 0,
      expectedChargeCents: 0,
      mrrSumCents: 0,
    };
    m.subscriptions += 1;
    m.expectedChargeCents += charge.cents ?? 0;
    m.mrrSumCents += mrr;
    byMonth.set(r.month, m);

    const srcAgg = bySource.get(r.source) ?? { subs: 0, chargeCents: 0 };
    srcAgg.subs += 1;
    srcAgg.chargeCents += charge.cents ?? 0;
    bySource.set(r.source, srcAgg);

    const cadenceKey = `${r.source}|${months}`;
    const c = cadenceAgg.get(cadenceKey) ?? { subs: 0, mrrTotal: 0, chargeTotal: 0 };
    c.subs += 1;
    c.mrrTotal += mrr;
    c.chargeTotal += charge.cents ?? 0;
    cadenceAgg.set(cadenceKey, c);
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  const cadences: CadenceBreakdown[] = [...cadenceAgg]
    .map(([key, c]) => {
      const [source, monthsStr] = key.split("|");
      const intervalCount = Number(monthsStr) || 1;
      const avgCharge = c.subs > 0 ? Math.round(c.chargeTotal / c.subs) : 0;
      return {
        source,
        intervalCount,
        subscriptions: c.subs,
        avgMrrCents: c.subs > 0 ? Math.round(c.mrrTotal / c.subs) : 0,
        avgChargeCents: avgCharge,
        // Annualised from the CHARGE now, not from MRR. MRR is the field that was wrong for
        // the prepaid plan, so comparing cadences through it reproduced the same error.
        annualisedCents: intervalCount > 0 ? Math.round((avgCharge * 12) / intervalCount) : 0,
      };
    })
    .sort((a, b) => b.subscriptions - a.subscriptions);

  const totalExpectedCents = months.reduce((s2, m) => s2 + m.expectedChargeCents, 0);
  const totalSubscriptions = months.reduce((s2, m) => s2 + m.subscriptions, 0);

  const biggest =
    months.length === 0
      ? null
      : months.reduce((a, b) => (b.expectedChargeCents > a.expectedChargeCents ? b : a));

  return {
    months,
    cadences,
    totalSubscriptions,
    totalExpectedCents,
    concentration:
      biggest && totalExpectedCents > 0
        ? { month: biggest.month, share: biggest.expectedChargeCents / totalExpectedCents }
        : null,
    // Per source. Across sources it fired on a Stripe monthly plan at $60/yr against a Skio
    // quarterly at $121.76/yr and called it a 2x anomaly — but those are different products
    // sold through different systems, so the comparison carried no information. The check was
    // built to catch one cadence of one product being normalised wrongly; scoping it to a
    // source keeps that and drops the noise.
    priceWarning:
      [...new Set(cadences.map((c) => c.source))]
        .map((src) => checkPriceDivergence(cadences.filter((c) => c.source === src)))
        .filter((w): w is string => w !== null)
        .join(" ") || null,
    derivedCount,
    unknownCount,
    sources: [...bySource]
      .map(([source, v]) => ({
        source,
        subscriptions: v.subs,
        expectedChargeCents: v.chargeCents,
      }))
      .sort((a, b) => b.subscriptions - a.subscriptions),
  };
}

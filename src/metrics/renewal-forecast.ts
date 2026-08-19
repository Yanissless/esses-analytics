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

/** Ratio between per-issue prices beyond which the two cadences are worth questioning. */
export const PRICE_DIVERGENCE_FACTOR = 2;

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
}

/** Flags cadences whose annualised price disagrees enough to distrust the total. */
export function checkPriceDivergence(cadences: CadenceBreakdown[]): string | null {
  const usable = cadences.filter((c) => c.subscriptions > 0 && c.annualisedCents > 0);
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
  const rows = await db.execute<{
    month: string;
    subs: number;
    charge_cents: string;
    mrr_cents: string;
  }>(sql`
    SELECT to_char(next_billing_at, 'YYYY-MM')                              AS month,
           count(*)::int                                                    AS subs,
           COALESCE(sum(mrr_amount * COALESCE(billing_interval_count, 1)), 0)::bigint
                                                                            AS charge_cents,
           COALESCE(sum(mrr_amount), 0)::bigint                             AS mrr_cents
      FROM subscription_meta
     WHERE status = 'active'
       AND next_billing_at IS NOT NULL
       AND next_billing_at >= now()
       AND next_billing_at < now() + (${monthsAhead} || ' months')::interval
     GROUP BY 1
     ORDER BY 1
  `);

  const cadenceRows = await db.execute<{
    interval_count: number;
    subs: number;
    avg_mrr: number;
  }>(sql`
    SELECT COALESCE(billing_interval_count, 1)::int AS interval_count,
           count(*)::int                            AS subs,
           COALESCE(round(avg(mrr_amount)), 0)::int  AS avg_mrr
      FROM subscription_meta
     WHERE status = 'active' AND next_billing_at IS NOT NULL
     GROUP BY 1
     ORDER BY 2 DESC
  `);

  const months: RenewalMonth[] = [...rows].map((r) => ({
    month: r.month,
    subscriptions: Number(r.subs),
    expectedChargeCents: Number(r.charge_cents),
    mrrSumCents: Number(r.mrr_cents),
  }));

  const cadences: CadenceBreakdown[] = [...cadenceRows].map((c) => {
    const n = Number(c.interval_count) || 1;
    const avgMrr = Number(c.avg_mrr);
    return {
      intervalCount: n,
      subscriptions: Number(c.subs),
      avgMrrCents: avgMrr,
      avgChargeCents: avgMrr * n,
      // MRR is per month by construction, so the annual equivalent is simply x12 —
      // independent of cadence, which is exactly what makes it comparable across them.
      annualisedCents: avgMrr * 12,
    };
  });

  const totalExpectedCents = months.reduce((s, m) => s + m.expectedChargeCents, 0);
  const totalSubscriptions = months.reduce((s, m) => s + m.subscriptions, 0);

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
    priceWarning: checkPriceDivergence(cadences),
  };
}

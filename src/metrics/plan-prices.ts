/**
 * What each subscription plan actually charges on a renewal.
 *
 * ## Why this is a hand-maintained table and not derived
 *
 * It was derived, from `subscription_meta.mrr_amount x billing_interval_count`, and it was
 * wrong for 865 of 1,785 active subscriptions — the plan named "Annual Payment, Quarterly
 * Delivery" came out at $26.28/yr against a real price of $100/yr, a 3.8x understatement.
 *
 * The cause is that plan's shape: it BILLS once every 12 months but DELIVERS quarterly, and
 * Skio queues a $25 order for each delivery with a $25 prepaid discount applied, so three of
 * the four collect nothing. Any figure derived from a per-delivery price has to know which of
 * those four is the real charge, and monthly-normalised MRR has already thrown that away.
 *
 * A list price is a decision someone made in Skio, not a fact discoverable from order history.
 * So it is written down here, reviewably, with the source named — and `renewalChargeCents`
 * reports whether it used a known price or fell back to arithmetic, so a page can never
 * present a derived guess as if it were the real number.
 *
 * ## These prices are EX-TAX, and that is why an average could never substitute
 *
 * A few regions charge sales tax on a subscription, so the amount collected there is higher
 * than the list price. That is what pushed the observed quarterly average to $31.28 against a
 * $30.00 list — the average was not noisy, it was measuring a different thing.
 *
 * Everything else in this app defines revenue as net ex-VAT (see `order_profit`), and tax is
 * remitted to the state rather than earned, so a renewal forecast has to be ex-tax too. Mixing
 * a tax-inclusive figure into it would overstate revenue by whatever share of the book sits in
 * a taxed region — small, plausible, and impossible to spot later.
 *
 * The consequence worth remembering: `subscription_meta.mrr_amount` carries tax for those
 * subscriptions, so any per-subscription average derived from it runs slightly high. That is a
 * second reason this table exists.
 *
 * ## Keeping it honest
 *
 * When a price changes in Skio, change it here. `check:deploy` does not validate these — there
 * is nothing to validate against — so the protection is that an unknown plan is REPORTED as
 * unknown rather than silently estimated.
 */

/** One renewal's charge, in cents, keyed by an exact `selling_plan_name`. */
export const PLAN_RENEWAL_PRICES: Record<string, number> = {
  // Confirmed by Sam, 18 Aug 2026: $100 charged once every 12 months. The quarterly orders
  // Skio queues alongside it are $0 — full prepaid discount — and must not be counted.
  "Annual Payment, Quarterly Delivery": 100_00,

  // Confirmed by Sam, 18 Aug 2026: $30 per quarterly renewal, ex-tax. The observed average
  // was $31.28 because taxed regions collect more; see the tax note above for why the list
  // price is the right figure here rather than the average.
  "Quarterly Subscription": 30_00,
};

export type PriceSource = "known-plan" | "derived-from-mrr" | "unknown";

export interface RenewalCharge {
  cents: number | null;
  source: PriceSource;
}

/**
 * The charge one renewal of this subscription should collect.
 *
 * Prefers the known list price. Falls back to `mrr x billing_interval_count`, which is right
 * for plans that bill and deliver on the same cadence — Sam confirmed the quarterly plan is
 * accurate this way — and wrong for any plan where those cadences differ. Returns
 * `source: "derived-from-mrr"` in that case so the caller can say so.
 */
export function renewalChargeCents(sub: {
  sellingPlanName: string | null;
  mrrCents: number;
  billingIntervalCount: number | null;
}): RenewalCharge {
  const known = sub.sellingPlanName ? PLAN_RENEWAL_PRICES[sub.sellingPlanName] : undefined;
  if (known !== undefined) return { cents: known, source: "known-plan" };

  const months = sub.billingIntervalCount ?? 1;
  if (!Number.isFinite(sub.mrrCents) || sub.mrrCents <= 0 || months <= 0) {
    return { cents: null, source: "unknown" };
  }
  return { cents: Math.round(sub.mrrCents * months), source: "derived-from-mrr" };
}

/**
 * True when a plan bills and delivers on different cadences, so per-delivery arithmetic
 * cannot be trusted for it AT ALL.
 *
 * The distinction matters for what a missing price means. For an ordinary plan, arithmetic is a
 * reasonable fallback that runs slightly high where tax applies. For a prepaid plan it is
 * simply wrong — off by the number of deliveries per billing cycle — so one of these missing
 * from the table is a defect rather than an approximation.
 *
 * Name-based on purpose: Skio's DeliveryPolicy is what the MRR calculation already tried to
 * use and evidently did not get for these subscriptions, so relying on it again to detect the
 * same problem would inherit the same blind spot.
 */
export function looksPrepaid(sellingPlanName: string | null): boolean {
  return /prepaid|annual payment|paid up ?front/i.test(sellingPlanName ?? "");
}

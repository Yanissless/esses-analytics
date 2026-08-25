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

/**
 * Billing cadence in months → the plan that bills on it.
 *
 * ## Why a second lookup exists
 *
 * 46 active subscriptions arrive from Skio with `selling_plan_name` null, so they fell to the
 * MRR fallback — which is exactly how the annual plan came out 3.8× low. The 27 annual ones
 * among them were being priced around $2.50 a year instead of $100.
 *
 * They are not a mystery plan. Grouped by billing interval they split cleanly along the two
 * plans that do exist, and their MRR ranges sit on top of those plans' averages:
 *
 *   every 12 months · 27 subs · MRR $2.08–$9.79   → "Annual Payment, Quarterly Delivery" (avg $2.11)
 *   every 3 months  · 19 subs · MRR $10.00–$25.00 → "Quarterly Subscription" (avg $10.26)
 *
 * So the cadence identifies the plan. That is inference rather than a stated fact, which is why
 * a match reports its own source — a caller can tell a looked-up name from a matched cadence.
 *
 * It is self-limiting too: `planForInterval` refuses when more than one known plan shares a
 * cadence, so adding a second 12-month plan makes these read "unknown" rather than quietly
 * being priced as the wrong one.
 */
export const PLAN_BILLING_MONTHS: Record<string, number> = {
  "Annual Payment, Quarterly Delivery": 12,
  "Quarterly Subscription": 3,
};

/** The single known plan billing on this cadence, or null when it is not unambiguous. */
export function planForInterval(months: number | null): string | null {
  if (months == null || months <= 0) return null;
  const matches = Object.entries(PLAN_BILLING_MONTHS)
    .filter(([, m]) => m === months)
    .map(([name]) => name);
  // Ambiguity means we genuinely do not know which plan this is, and guessing would reintroduce
  // exactly the error this file exists to prevent.
  return matches.length === 1 ? matches[0] : null;
}

export type PriceSource =
  | "known-plan"
  /** The plan name was missing, and the billing cadence matched exactly one known plan. */
  | "matched-by-interval"
  | "derived-from-mrr"
  | "unknown";

export interface RenewalCharge {
  cents: number | null;
  source: PriceSource;
}

/**
 * The charge one renewal of this subscription should collect.
 *
 * Three steps, in decreasing confidence:
 *
 *  1. The plan name is in the price table. A stated fact.
 *  2. No name, but the billing cadence matches exactly one known plan — see
 *     `PLAN_BILLING_MONTHS`. Strong inference, and it rescues the 46 nameless subscriptions
 *     from step 3.
 *  3. `mrr × billing_interval_count`. Right for plans that bill and deliver on the same
 *     cadence, and wrong by the number of deliveries per cycle for any plan where they differ.
 *
 * Every step names itself in `source`, so a page can never present a guess as a real price.
 */
export function renewalChargeCents(sub: {
  sellingPlanName: string | null;
  mrrCents: number;
  billingIntervalCount: number | null;
}): RenewalCharge {
  const known = sub.sellingPlanName ? PLAN_RENEWAL_PRICES[sub.sellingPlanName] : undefined;
  if (known !== undefined) return { cents: known, source: "known-plan" };

  // Only when the name is genuinely absent. A name that is present but unrecognised is a new
  // plan somebody added in Skio, and pricing it off a cadence would hide that.
  if (!sub.sellingPlanName) {
    const matched = planForInterval(sub.billingIntervalCount);
    const price = matched ? PLAN_RENEWAL_PRICES[matched] : undefined;
    if (price !== undefined) return { cents: price, source: "matched-by-interval" };
  }

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

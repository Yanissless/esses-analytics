/**
 * Which discount codes are free-issue ACQUISITION promotions.
 *
 * Sam's decision, 18 Aug 2026: a free first issue is an acquisition cost, not a prepaid
 * delivery. Nobody paid for it, so the product and shipping behind it is money spent to win a
 * subscriber — the same category as ad spend.
 *
 * ## Why this is a written-down list rather than a rule
 *
 * The obvious rule — "a $0 order from a customer who has never paid before" — reclassifies
 * 4,473 orders when only 1,907 are promotions. It sweeps in the ordinary quarterly issue
 * fulfilments, because for those the money arrives on the SUBSCRIPTION charge rather than on
 * the delivery order, so the delivery legitimately looks unpaid in isolation.
 *
 * There is no signal in the order data that separates "free because we gave it away" from
 * "free because it was already paid for elsewhere". The distinction lives in what each promo
 * code was created to do, which is knowledge, not data. So it is written down, with dates and
 * the observed cost, and anything not listed keeps its existing classification.
 *
 * ## Codes and what they cost
 *
 * Measured over all history on $0 `subscription_shopify` orders, product + shipping + other
 * fulfilment:
 *
 *   FREEFIRSTISSUE   879 orders   $18,613.85   19 Jul 2026 - current
 *   D1G90FJ1GQ28     797 orders   $16,065.21    2 Mar - 17 Jun 2026
 *   THANKYOU100      197 orders    $4,008.31   16 Mar - 15 Jul 2026
 *   f34hzrhds         34 orders      $764.24   17 Feb -  9 Jul 2026
 *                                 ----------
 *                                  $39,451.61  across 1,905 customers = $20.71 each
 *
 * The two opaque codes are Skio-generated. They are included because they behave identically
 * to the named ones — $0 subscription orders in a contiguous date range, one per customer, no
 * prior payment — and excluding them would leave 60% of the cost invisible for the sake of
 * tidiness.
 *
 * ⚠️ AWAITING CONFIRMATION: Sam has confirmed the policy but not yet this specific list.
 * D1G90FJ1GQ28 and f34hzrhds are inferred from behaviour, not from knowing what they were for.
 */

/** Codes whose $0 orders are acquisition giveaways. Compared case-insensitively. */
export const ACQUISITION_PROMO_CODES = [
  "FREEFIRSTISSUE",
  "D1G90FJ1GQ28",
  "THANKYOU100",
  "F34HZRHDS",
] as const;

/** Uppercased set for matching. */
const CODE_SET = new Set<string>(ACQUISITION_PROMO_CODES.map((c) => c.toUpperCase()));

export function isAcquisitionPromo(code: string | null | undefined): boolean {
  return CODE_SET.has((code ?? "").trim().toUpperCase());
}

/** POSIX alternation for the same list, for use in SQL `~*`. Kept derived so the two can't drift. */
export const ACQUISITION_PROMO_SQL_REGEX = `^(${ACQUISITION_PROMO_CODES.join("|")})$`;

/**
 * CAC with or without free-issue cost — and why it is a toggle rather than a fix.
 *
 * Sam, 18 Aug 2026: "can we keep it seperate and create a toggle to include them or not, we
 * would hope that number goes down as the free first quarter customers renew."
 *
 * ## Why both figures have to exist
 *
 * Marketing-only CAC is what has been quoted historically and what every ad platform reports.
 * Including free-issue cost is truer — the magazine and postage genuinely were spent to win the
 * subscriber — but it is a different number, roughly 3.5x larger on this account.
 *
 * Silently switching to the truer one would have made every CAC figure quoted before today
 * non-comparable with every figure after, with nothing in the app to explain the step change.
 * A metric that quietly changes definition is worse than two clearly-named ones, so the basis
 * is explicit, in the URL, and printed beside the number.
 *
 * ## The hope Sam named, and why the denominator matters
 *
 * "we would hope that number goes down as the free first quarter customers renew."
 *
 * That is right, and it only works if the denominator is NEW CUSTOMERS ACQUIRED rather than
 * paying customers. As a free-quarter cohort renews, cost stays fixed while nothing is added to
 * the denominator — so `cacIncludingFreeIssues` does NOT fall on renewal. What falls is
 * `costPerPayingCustomer`, which divides the same cost by those who actually went on to pay.
 *
 * Both are returned. The first answers "what did it cost to get them through the door", the
 * second "what did it cost to get one who pays" — and only the second improves as a cohort
 * matures. Reporting one as if it were the other would leave Sam watching a figure that cannot
 * move and concluding the promo is not working.
 */

import { ratio } from "./formulas";

export type CacBasis = "marketing-only" | "with-free-issues";

export const CAC_BASES: Array<{ id: CacBasis; label: string; blurb: string }> = [
  {
    id: "marketing-only",
    label: "Marketing only",
    blurb: "Ad spend divided by new customers. What has been quoted historically.",
  },
  {
    id: "with-free-issues",
    label: "+ free issues",
    blurb: "Adds the product and postage of free first issues. Truer, and about 3.5x larger.",
  },
];

export function isCacBasis(v: string | undefined): v is CacBasis {
  return CAC_BASES.some((b) => b.id === v);
}

export interface CacBreakdown {
  basis: CacBasis;
  /** Ad spend in the window. */
  marketingCents: number;
  /** Free-issue product and postage in the window. Zero on the marketing-only basis. */
  freeIssueCents: number;
  /** What the chosen basis charges in total. */
  totalCents: number;
  newCustomers: number;

  /** The headline: totalCents / newCustomers. */
  cac: number | null;
  /** Marketing-only CAC, always computed so the two can be shown side by side. */
  cacMarketingOnly: number | null;
  /** CAC including free issues, always computed for the same reason. */
  cacWithFreeIssues: number | null;

  /**
   * Cost per customer who actually went on to PAY. The figure that improves as a free-quarter
   * cohort renews — see the note at the top of this file. Null without a paying count.
   */
  costPerPayingCustomer: number | null;

  /** How much larger the inclusive figure is, as a multiple. Null when either is unavailable. */
  inclusiveMultiple: number | null;
}

/**
 * Both CAC figures from the same inputs.
 *
 * `payingCustomers` is optional because it comes from cohort analysis rather than the period
 * rollup, and is only known once a cohort has matured. Absent, `costPerPayingCustomer` is null
 * rather than falling back to `newCustomers` — those are different populations, and quietly
 * substituting one would make the number look measurable before it is.
 */
export function buildCac(input: {
  basis: CacBasis;
  marketingCents: number;
  freeIssueCents: number;
  newCustomers: number;
  payingCustomers?: number | null;
}): CacBreakdown {
  const { basis, marketingCents, freeIssueCents, newCustomers } = input;

  const included = basis === "with-free-issues" ? freeIssueCents : 0;
  const totalCents = marketingCents + included;

  const cacMarketingOnly = ratio(marketingCents, newCustomers);
  const cacWithFreeIssues = ratio(marketingCents + freeIssueCents, newCustomers);

  const paying = input.payingCustomers ?? null;

  return {
    basis,
    marketingCents,
    freeIssueCents: included,
    totalCents,
    newCustomers,
    cac: ratio(totalCents, newCustomers),
    cacMarketingOnly,
    cacWithFreeIssues,
    costPerPayingCustomer:
      paying !== null && paying > 0 ? ratio(marketingCents + freeIssueCents, paying) : null,
    inclusiveMultiple:
      cacMarketingOnly !== null && cacWithFreeIssues !== null && cacMarketingOnly > 0
        ? cacWithFreeIssues / cacMarketingOnly
        : null,
  };
}

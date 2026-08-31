/**
 * The issue release calendar, and renewals counted against it.
 *
 * ## Why renewals are keyed to releases and not to anniversaries
 *
 * Sam's team manually moves every subscription's `next_billing_at` in Skio to line up with the
 * magazine's release date. So a subscriber who signs up on 3 March is not billed again on
 * 3 June — they are billed when the next issue ships, on 15 May. Renewal timing is a property
 * of the publishing calendar, not of the individual subscription.
 *
 * `churn.ts` assumed the opposite, counting cycles as `floor(monthsLived / billingMonths)`. That
 * is a reasonable default for a normal subscription business and wrong here, and the reconcile
 * against Sam's manual cohort sheet shows exactly how wrong:
 *
 *   Mar–Apr cohort, cancels before first renewal:  sheet 319 (28.03%) · app 438 (37.76%)
 *   Jul–Aug cohort, cancels before first renewal:  sheet 512 (44.79%) · app 630 (53.80%)
 *
 * Total cancellations agreed almost exactly (541 vs 546, 624 vs 630) and survivors agreed to
 * within half a point. Only the BOUNDARIES differed — the anniversary window is longer than the
 * gap to the next release for most signups, so it swept cancellations out of cycle 2 and into
 * cycle 1, overstating first-renewal churn by about ten points.
 *
 * ## Why the schedule is declared rather than derived
 *
 * `churn.ts` currently infers release dates from the first non-pre-order sale of each issue.
 * That works backwards from evidence and inherits every quirk of the order data — the back
 * catalogue problem documented there is a real example, where issue 01's first in-range sale
 * landed after issue 03's. A publishing calendar is a decision somebody made, and it is known in
 * advance. Declaring it is both simpler and correct for future dates, which no amount of order
 * history can supply.
 */

/** Months (1-12) an issue ships in. Confirmed by Sam: Feb, May, Aug, Nov. */
export const RELEASE_MONTHS = [2, 5, 8, 11] as const;

/** Day of the month an issue ships. */
export const RELEASE_DAY = 15;

/**
 * Every release date in a range, inclusive of both ends.
 *
 * UTC throughout. A release is a calendar fact rather than a moment, and using local time would
 * shift the boundary by a day for anyone west of Greenwich — which for a cohort boundary means
 * a subscriber landing in a different cycle depending on who ran the report.
 */
export function releasesBetween(from: Date, to: Date): Date[] {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return [];
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) return [];
  if (to < from) return [];

  const out: Date[] = [];
  for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year += 1) {
    for (const month of RELEASE_MONTHS) {
      const d = new Date(Date.UTC(year, month - 1, RELEASE_DAY));
      if (d >= from && d <= to) out.push(d);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** The first release strictly after `date`, or null beyond the horizon searched. */
export function nextReleaseAfter(date: Date, horizonYears = 3): Date | null {
  const end = new Date(
    Date.UTC(date.getUTCFullYear() + horizonYears, date.getUTCMonth(), date.getUTCDate()),
  );
  const after = releasesBetween(date, end).filter((d) => d > date);
  return after[0] ?? null;
}

/**
 * How many releases a subscription has lived through — its renewal opportunities.
 *
 * Strictly after the start date: someone who subscribes ON release day is buying that issue, not
 * renewing into it. Their first renewal is the next one.
 */
export function releasesFaced(startedAt: Date, asOf: Date): number {
  if (asOf <= startedAt) return 0;
  return releasesBetween(startedAt, asOf).filter((d) => d > startedAt).length;
}


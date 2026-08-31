/**
 * How many renewals a subscription actually completed.
 *
 * ## Why this counts charges rather than calendar windows
 *
 * A calendar tells you when a renewal was DUE. It cannot tell you whether it happened, and that
 * is the question a churn cohort asks.
 *
 * Worse, here the calendar answer is unrecoverable. The team moves `next_billing_at` forward by
 * hand so every subscription bills on the magazine's release date, which overwrites the only
 * record of when the previous renewal had been scheduled. The history needed to reconstruct
 * "which renewal did this cancellation precede" is gone from the subscription row.
 *
 * Paid charges survive that. One paid charge means billed once and never renewed; two means
 * renewed once.
 *
 * ## It reproduces the manual analysis, where calendar models did not
 *
 * Four calendar-based models were tried against Sam's cohort sheet and each missed by 90–400
 * subscriptions, in both directions. Anniversary windows put too many cancellations in the first
 * bucket; release-keyed windows put too few. Charges land on it:
 *
 *   Mar–Apr, cancelled having never been billed again:  sheet 319 · charges 320
 *   Mar–Apr, cancelled after exactly one renewal:       sheet 191 · charges 181
 *   Jul–Aug, cancelled having never been billed again:  sheet 512 · charges 540
 *
 * One subscription apart on the headline, and the remaining differences track the cohort-size
 * difference (+22 and +28 signups) rather than disagreeing about renewals.
 *
 * ## The caveat that must travel with it
 *
 * Only 77.7% of subscriptions have any linked order. The rest are mostly Craft/Stripe migrants
 * whose charges live on the other platform, and counting them this way would report them as
 * 100% never-renewed — a missing link masquerading as a cancellation. `countable` exists so a
 * caller has to decide about them explicitly instead of averaging them in.
 */

export interface SubscriptionRenewalInput {
  /** Paid charges linked to this subscription. $0 fulfilment orders must not be counted. */
  paidCharges: number;
  cancelled: boolean;
  /** False when no order is linked at all, so charges cannot be read. */
  hasLinkedOrders: boolean;
}

/** Renewals completed. The first charge is the signup, so renewals are one fewer. */
export function renewalsCompleted(paidCharges: number): number {
  return Math.max(0, paidCharges - 1);
}

/**
 * Whether this subscription can be measured by charges at all.
 *
 * A subscription with no linked orders is unmeasurable rather than un-renewed, and the
 * difference matters: treating it as un-renewed inflates churn by however many migrants sit in
 * the cohort.
 */
export function countable(sub: SubscriptionRenewalInput): boolean {
  return sub.hasLinkedOrders;
}

/**
 * Which renewal a cancellation fell before — 1 means "cancelled without ever renewing".
 *
 * Null for a live subscription, so a survivor is distinguishable from someone who churned
 * immediately rather than both collapsing into the same number.
 */
export function cancelledBeforeRenewal(sub: SubscriptionRenewalInput): number | null {
  if (!sub.cancelled) return null;
  return renewalsCompleted(sub.paidCharges) + 1;
}

export interface CohortChurn {
  /** Subscriptions with linked orders — the only ones these figures describe. */
  measured: number;
  /** Excluded for having no linked order. Reported, never folded in. */
  unmeasurable: number;
  /** Cancelled without ever renewing. */
  churnedBeforeFirstRenewal: number;
  /** Cancelled after exactly one renewal. */
  churnedAfterFirst: number;
  /** Cancelled after two or more renewals. */
  churnedLater: number;
  stillLive: number;
  /** Share of measured subscriptions that never renewed, or null when there are none. */
  firstRenewalChurnRate: number | null;
}

/**
 * Bucket a cohort by how far it got.
 *
 * Rates divide by `measured`, never by the full cohort: an unmeasurable subscription has not
 * declined to renew, it simply cannot be read, and dividing by it understates the rate.
 */
export function cohortChurn(subs: SubscriptionRenewalInput[]): CohortChurn {
  let unmeasurable = 0;
  let before1 = 0;
  let after1 = 0;
  let later = 0;
  let live = 0;

  for (const s of subs) {
    if (!countable(s)) {
      unmeasurable += 1;
      continue;
    }
    const bucket = cancelledBeforeRenewal(s);
    if (bucket === null) {
      live += 1;
    } else if (bucket === 1) {
      before1 += 1;
    } else if (bucket === 2) {
      after1 += 1;
    } else {
      later += 1;
    }
  }

  const measured = subs.length - unmeasurable;
  return {
    measured,
    unmeasurable,
    churnedBeforeFirstRenewal: before1,
    churnedAfterFirst: after1,
    churnedLater: later,
    stillLive: live,
    firstRenewalChurnRate: measured > 0 ? before1 / measured : null,
  };
}

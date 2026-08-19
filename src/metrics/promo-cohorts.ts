/**
 * Free-issue promo performance — what each promotion cost, and what it kept.
 *
 * Sam: "we want to see how many are dropping off at first second renewal etc to determine true
 * performance/cost of the promo." A free-issue offer cannot be judged on how many people took
 * it — everyone takes a free thing. It can only be judged on how many paid afterwards.
 *
 * ## The comparison this module exists to keep fair
 *
 * The raw figures invite a badly wrong conclusion. Measured 18 Aug 2026:
 *
 *   D1G90FJ1GQ28    824 customers   60.4% went on to pay   avg 149 days old
 *   THANKYOU100     388 customers    3.4% went on to pay   avg 143 days old
 *   FREEFIRSTISSUE  887 customers   29.3% went on to pay   avg  14 days old
 *
 * Read flat, THANKYOU100 looks like a catastrophe and FREEFIRSTISSUE looks mediocre. Neither
 * is supported, because the cohorts are not comparable:
 *
 *  - **FREEFIRSTISSUE is 14 days old.** A quarterly subscription renews after ~90 days, so most
 *    of that cohort has not yet had the OPPORTUNITY to pay. Its conversion rate is measuring
 *    elapsed time, not the offer.
 *  - **THANKYOU100 sits largely on the annual plan**, which renews once every 12 months — and
 *    every annual renewal in this book falls in Nov 2026. Those subscribers have not declined
 *    to pay; they have not been asked yet.
 *
 * So conversion is reported only against customers who have actually reached a renewal date. A
 * cohort with none reports `null` rather than a number: a promo cannot be graded before its
 * first renewal cycle completes, and saying so is more useful than a percentage that will move
 * on its own.
 *
 * Maturity is computed per CUSTOMER from their own subscription's billing interval, never per
 * cohort from an average — a cohort mixing quarterly and annual plans has two clocks running,
 * and averaging them would report every mixed cohort as half-mature.
 *
 * ## Cost boundary
 *
 * Product + shipping + other fulfilment on the $0 order, from `order_profit` — the same
 * boundary the rest of the app uses, so it can sit beside ad spend without mixing conventions.
 * It EXCLUDES ad spend: this is the cost of the free issue itself, and whatever was paid to put
 * the offer in front of someone is already on /creatives. Adding them is the full picture, and
 * the page says so rather than quietly doing it.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  ACQUISITION_PROMO_SQL_REGEX,
  ALL_PROMO_SQL_REGEX,
  promoDefinition,
  type PromoPurpose,
} from "./acquisition-promos";
import { ratio } from "./formulas";

/** Days allowed past a renewal date before counting it as an opportunity the customer had. */
export const RENEWAL_GRACE_DAYS = 7;

/** Below this many matured customers, a conversion rate is noise and is withheld. */
export const MIN_MATURED_TO_RATE = 20;

export interface CohortGrade {
  /** True when a conversion rate may be published for this cohort. */
  rateable: boolean;
  /** Populated when the cohort is too young or too small to grade. */
  caveat: string | null;
}

/**
 * Whether a cohort has earned a published conversion rate.
 *
 * Two gates, in order. A cohort with nobody past a renewal date has nothing to say at all —
 * a rate there measures elapsed time. A cohort with a handful past one has a rate that will
 * swing wildly on the next few, which is noise wearing a percentage sign.
 */
export function gradeCohort(customers: number, matured: number): CohortGrade {
  if (matured === 0) {
    return {
      rateable: false,
      caveat:
        `None of these ${customers} customers has reached a renewal date yet, so there is ` +
        "nothing to grade. A conversion rate here would measure elapsed time, not the offer.",
    };
  }
  if (matured < MIN_MATURED_TO_RATE) {
    return {
      rateable: false,
      caveat:
        `Only ${matured} of ${customers} have reached a renewal date — below ` +
        `${MIN_MATURED_TO_RATE}, so a rate would be noise. Reported, not graded.`,
    };
  }
  if (matured < customers) {
    return {
      rateable: true,
      caveat:
        `${customers - matured} of ${customers} have not reached a renewal date yet and are ` +
        `excluded from the rates, which describe the ${matured} that have.`,
    };
  }
  return { rateable: true, caveat: null };
}

export interface PromoCohort {
  promo: string;
  /** What the code was for. Drives whether a conversion rate means anything. */
  purpose: PromoPurpose;
  /** Human description from the registry. */
  label: string;
  /** Everyone who received a free issue on this code. */
  customers: number;
  firstGifted: string;
  lastGifted: string;
  /** Product + shipping + other fulfilment on the free issues. */
  costCents: number;
  costPerCustomerCents: number | null;

  /**
   * Customers whose first renewal date has passed, plus grace. The only fair denominator for a
   * conversion rate — the rest have not been asked to pay yet.
   */
  matured: number;
  /** Of the matured, how many paid at least once after the gift. */
  convertedFirst: number;
  /** Of those, how many paid a second time. */
  convertedSecond: number;

  /** convertedFirst / matured. Null when too few have matured to say. */
  firstRenewalRate: number | null;
  /** convertedSecond / convertedFirst — survival among those who did renew once. */
  secondRenewalRate: number | null;

  /** Cost divided by customers who actually converted. The real acquisition cost. */
  costPerConvertedCents: number | null;

  stillActive: number;
  cancelled: number;
  /**
   * Cancelled without ever paying — churned before their first renewal date. Meaningful even
   * for a cohort too young to have a conversion rate, because it needs no renewal to have
   * happened: these people left while the free issue was the only thing they had received.
   */
  churnedUnpaid: number;
  /** churnedUnpaid / customers. Safe on any cohort, mature or not. */
  churnedUnpaidRate: number | null;

  /** Populated when the cohort is too young or too small to grade. */
  caveat: string | null;
}

export interface PromoCohortReport {
  cohorts: PromoCohort[];
  /** Every giveaway, whatever its purpose. */
  totalCostCents: number;
  totalCustomers: number;
  /**
   * Acquisition only — the figure that belongs in CAC. Excludes comps, which are a
   * relationship cost, and win-back, which is spent on people already acquired once.
   */
  acquisitionCostCents: number;
  acquisitionCustomers: number;
  winBackCostCents: number;
  compCostCents: number;
  /** Cohorts where nobody has reached a renewal date yet. Comps are never counted here. */
  immatureCohorts: number;
}

export async function getPromoCohorts(): Promise<PromoCohortReport> {
  const rows = await db.execute<{
    promo: string;
    customers: number;
    first_gifted: string;
    last_gifted: string;
    cost_cents: string;
    matured: number;
    converted_first: number;
    converted_second: number;
    still_active: number;
    cancelled: number;
    churned_unpaid: number;
  }>(sql`
    WITH gift AS (
      SELECT o.customer_id,
             upper(trim(c))      AS promo,
             min(o.processed_at) AS gifted_at,
             sum(p.cogs_amount + p.ship_cost_amount + p.other_fulfil_amount) AS cost
        FROM orders o
        JOIN order_profit p ON p.order_id = o.id
        CROSS JOIN LATERAL unnest(COALESCE(o.discount_codes, ARRAY[]::text[])) AS c
       WHERE o.test = false AND o.cancelled_at IS NULL
         AND o.total_amount <= 0
         AND o.order_type = 'subscription_shopify'
         AND upper(trim(c)) ~* ${ALL_PROMO_SQL_REGEX}
         AND o.customer_id IS NOT NULL
       GROUP BY 1, 2
    ),
    scoped AS (
      SELECT g.customer_id, g.promo, g.gifted_at, g.cost,
             COALESCE(
               (SELECT min(COALESCE(sm.billing_interval_count, 3))
                  FROM subscription_meta sm WHERE sm.customer_id = g.customer_id),
               3
             ) AS interval_months,
             (SELECT count(*) FROM orders o2
               WHERE o2.customer_id = g.customer_id
                 AND o2.test = false AND o2.cancelled_at IS NULL
                 AND o2.total_amount > 0
                 AND o2.processed_at > g.gifted_at) AS paid_after,
             -- Mutually exclusive on purpose. bool_or on each status independently counted a
             -- customer holding one active and one cancelled subscription in BOTH columns, so
             -- THANKYOU100 reported 195 active + 167 cancelled out of 197 customers. A customer
             -- with any active subscription is active; only one with none is cancelled.
             (SELECT bool_or(sm.status = 'active')
                FROM subscription_meta sm WHERE sm.customer_id = g.customer_id) AS is_active,
             (SELECT bool_or(sm.status = 'canceled') AND NOT bool_or(sm.status = 'active')
                FROM subscription_meta sm WHERE sm.customer_id = g.customer_id) AS is_cancelled
        FROM gift g
    ),
    judged AS (
      SELECT s.promo, s.cost, s.gifted_at, s.paid_after, s.is_active, s.is_cancelled,
             -- Cancelled without ever paying: churned before being asked to renew. The only
             -- thing that CAN be said about a cohort too young to have a conversion rate.
             (s.is_cancelled AND s.paid_after = 0) AS churned_unpaid,
             (now() >= s.gifted_at
                       + (s.interval_months || ' months')::interval
                       + (${RENEWAL_GRACE_DAYS} || ' days')::interval) AS matured
        FROM scoped s
    )
    SELECT promo,
           count(*)::int                                             AS customers,
           min(gifted_at)::date::text                                AS first_gifted,
           max(gifted_at)::date::text                                AS last_gifted,
           COALESCE(sum(cost), 0)::bigint                            AS cost_cents,
           count(*) FILTER (WHERE matured)::int                       AS matured,
           count(*) FILTER (WHERE matured AND paid_after >= 1)::int    AS converted_first,
           count(*) FILTER (WHERE matured AND paid_after >= 2)::int    AS converted_second,
           count(*) FILTER (WHERE is_active)::int                      AS still_active,
           count(*) FILTER (WHERE is_cancelled)::int                   AS cancelled,
           count(*) FILTER (WHERE churned_unpaid)::int                  AS churned_unpaid
      FROM judged
     GROUP BY promo
     ORDER BY count(*) DESC
  `);

  const cohorts: PromoCohort[] = [...rows].map((r) => {
    const customers = Number(r.customers);
    const matured = Number(r.matured);
    const first = Number(r.converted_first);
    const second = Number(r.converted_second);
    const cost = Number(r.cost_cents);

    const def = promoDefinition(r.promo);
    const purpose: PromoPurpose = def?.purpose ?? "acquisition";

    // A comp is never graded. Its recipients were never meant to pay, so a 0% conversion
    // rate would invent a failure from a decision that had nothing to do with revenue.
    const graded =
      purpose === "comp"
        ? {
            rateable: false,
            caveat:
              "Lifetime free access for clients and VIPs. These recipients are not expected " +
              "to convert, so no rate is shown and their cost is excluded from acquisition.",
          }
        : gradeCohort(customers, matured);
    const { rateable, caveat } = graded;

    return {
      promo: r.promo,
      purpose,
      label: def?.label ?? r.promo,
      customers,
      firstGifted: r.first_gifted,
      lastGifted: r.last_gifted,
      costCents: cost,
      costPerCustomerCents: ratio(cost, customers),
      matured,
      convertedFirst: first,
      convertedSecond: second,
      firstRenewalRate: rateable ? ratio(first, matured) : null,
      secondRenewalRate: rateable && first > 0 ? ratio(second, first) : null,
      // Withheld alongside the rate. Reporting $2,004.15 per conversion off 2 conversions —
      // as an earlier version did — is the same noise wearing a more authoritative unit.
      costPerConvertedCents: rateable && first > 0 ? ratio(cost, first) : null,
      stillActive: Number(r.still_active),
      cancelled: Number(r.cancelled),
      churnedUnpaid: Number(r.churned_unpaid),
      churnedUnpaidRate: ratio(Number(r.churned_unpaid), customers),
      caveat,
    };
  });

  const byPurpose = (p: PromoPurpose) => cohorts.filter((c) => c.purpose === p);
  const sumCost = (list: PromoCohort[]) => list.reduce((n, c) => n + c.costCents, 0);

  return {
    cohorts,
    totalCostCents: sumCost(cohorts),
    totalCustomers: cohorts.reduce((n, c) => n + c.customers, 0),
    acquisitionCostCents: sumCost(byPurpose("acquisition")),
    acquisitionCustomers: byPurpose("acquisition").reduce((n, c) => n + c.customers, 0),
    winBackCostCents: sumCost(byPurpose("win-back")),
    compCostCents: sumCost(byPurpose("comp")),
    // Comps are excluded: they are not waiting to mature, they are never going to convert.
    immatureCohorts: cohorts.filter((c) => c.purpose !== "comp" && c.matured === 0).length,
  };
}

export interface FreeIssueCost {
  since: string;
  until: string;
  /** Product + shipping + fulfilment on ACQUISITION free issues shipped in the window. */
  costCents: number;
  /** Free issues shipped in the window. */
  issues: number;
  /** Purposes excluded from the figure, so a caller can say what it does NOT contain. */
  excluded: string;
}

/**
 * Free-issue acquisition cost inside a date range, for the CAC toggle.
 *
 * Deliberately narrower than `getPromoCohorts`, which is all-time because a cohort's whole
 * point is what happened to it over time. This one is windowed, because a CAC for a period has
 * to charge the cost incurred IN that period.
 *
 * ACQUISITION ONLY. Comps are a relationship cost and win-back is money spent on someone
 * already acquired once; folding either into CAC would overstate the cost of finding a new
 * subscriber. `excluded` names them so the page can say so rather than leaving it implied.
 */
export async function getFreeIssueCost(since: string, until: string): Promise<FreeIssueCost> {
  const rows = await db.execute<{ cost_cents: string; issues: number }>(sql`
    SELECT COALESCE(sum(p.cogs_amount + p.ship_cost_amount + p.other_fulfil_amount), 0)::bigint
             AS cost_cents,
           count(*)::int AS issues
      FROM orders o
      JOIN order_profit p ON p.order_id = o.id
      CROSS JOIN LATERAL unnest(COALESCE(o.discount_codes, ARRAY[]::text[])) AS c
     WHERE o.test = false AND o.cancelled_at IS NULL
       AND o.total_amount <= 0
       AND o.order_type = 'subscription_shopify'
       AND upper(trim(c)) ~* ${ACQUISITION_PROMO_SQL_REGEX}
       AND o.processed_at::date >= ${since}
       AND o.processed_at::date <= ${until}
  `);

  const row = [...rows][0];
  return {
    since,
    until,
    costCents: Number(row?.cost_cents ?? 0),
    issues: Number(row?.issues ?? 0),
    excluded: "win-back offers and VIP comps",
  };
}

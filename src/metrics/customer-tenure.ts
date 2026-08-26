/**
 * First-time buyers versus repeat buyers.
 *
 * ## Why "returning orders" could not answer this
 *
 * The rollup already carries `new_customers` and `returning_orders`, derived from
 * `acquisition_order` — the earliest order per customer. Everything else is "returning". For a
 * shop that would be fine. For a subscription magazine it is badly wrong, and the data says how
 * badly: of 6,212 non-acquisition orders,
 *
 *   3,375 (54%) are prepaid_delivery — an issue shipped against money taken earlier
 *     414 ( 7%) are comps
 *      29        are acquisition gifts
 *   2,394 (39%) are actual paid purchases
 *
 * So 61% of "returning orders" collected nothing. An annual subscriber receives four delivery
 * orders a year and would read as a five-order repeat customer having paid once. Any repeat
 * rate built on order counts is inflated by roughly two and a half times.
 *
 * Everything here therefore counts PAID purchases — a customer is a repeat buyer when they have
 * paid us more than once, which is the thing anyone actually means by the phrase.
 *
 * ## Why "first-time" needs a caveat rather than a definition
 *
 * 979 customers' earliest Shopify order is a `prepaid_delivery`, meaning they subscribed and
 * paid on Craft/Stripe and Shopify only ever saw the shipment. They are not first-time
 * customers; they are migrated ones whose purchase history lives on another platform. Calling
 * them new would overstate acquisition, and dropping them would understate the book — so they
 * are counted and labelled separately.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";

/**
 * How long a free signup gets before its conversion is judged.
 *
 * A free first issue converts when the customer pays for the next one, roughly a quarter later.
 * Counting someone who signed up last week as "did not convert" understates the rate by however
 * many recent signups there are — the same maturity trap the promo cohorts hit, where 306 of 311
 * "failures" included people who had not yet been asked to renew.
 */
export const MATURITY_DAYS = 120;

/** Below this, a conversion rate is a coin flip with extra steps. */
export const MIN_COHORT_TO_RATE = 20;

export type AcquisitionRoute = "paid" | "acquisition_gift" | "prepaid_delivery" | "comp";

export interface RouteConversion {
  route: AcquisitionRoute;
  /** Everyone acquired this way. */
  customers: number;
  /** Acquired long enough ago to have had a fair chance to buy again. */
  matured: number;
  /** Of the matured, how many have ever paid. */
  everPaid: number;
  /** Of the matured, how many have paid more than once. */
  repeatBuyers: number;
  /** everPaid / matured, or null below the volume floor. */
  conversionRate: number | null;
  /** repeatBuyers / matured, or null below the floor. */
  repeatRate: number | null;
}

export interface FrequencyBucket {
  /** Number of paid purchases. The last bucket is a floor, labelled by the caller. */
  paidPurchases: number;
  customers: number;
}

export interface TenureSummary {
  /** Customers who have paid at least once. The only population a repeat rate can describe. */
  payingCustomers: number;
  /** Paid exactly once. */
  firstTimeOnly: number;
  /** Paid more than once. */
  repeatBuyers: number;
  /** repeatBuyers / payingCustomers, or null when nobody has paid. */
  repeatRate: number | null;
  /** Customers with orders but no payment — free issues, comps, deliveries against Stripe. */
  neverPaid: number;
  /** Net ex-VAT from each customer's FIRST paid purchase. */
  firstPurchaseCents: number;
  /** Net ex-VAT from every paid purchase after the first. */
  repeatPurchaseCents: number;
  /** repeatPurchaseCents / (both), or null when there is no paid revenue. */
  repeatRevenueShare: number | null;
}

const n = (v: unknown): number => Number(v ?? 0);

/** A share, or null rather than 0 or Infinity when the denominator is empty. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * Conversion and repeat rates for one acquisition route.
 *
 * Pure so the maturity and volume rules are testable. Both rates use `matured` as the
 * denominator, never the full cohort: dividing by everyone counts customers who have not yet had
 * the chance to buy again as though they had declined.
 */
export function rateCohort(input: {
  route: AcquisitionRoute;
  customers: number;
  matured: number;
  everPaid: number;
  repeatBuyers: number;
}): RouteConversion {
  const ratable = input.matured >= MIN_COHORT_TO_RATE;
  return {
    ...input,
    conversionRate: ratable ? share(input.everPaid, input.matured) : null,
    repeatRate: ratable ? share(input.repeatBuyers, input.matured) : null,
  };
}

/** The headline split, counted on paid purchases. */
export async function getTenureSummary(): Promise<TenureSummary> {
  const [counts] = [
    ...(await db.execute<{
      paying: number;
      first_only: number;
      repeat: number;
      never_paid: number;
    }>(sql`
      WITH per_customer AS (
        SELECT o.customer_id,
               count(*) FILTER (WHERE op.revenue_class = 'paid') AS paid_orders
          FROM orders o
          JOIN order_profit op ON op.order_id = o.id
         WHERE o.customer_id IS NOT NULL
         GROUP BY 1
      )
      SELECT count(*) FILTER (WHERE paid_orders >= 1)::int AS paying,
             count(*) FILTER (WHERE paid_orders = 1)::int  AS first_only,
             count(*) FILTER (WHERE paid_orders >= 2)::int AS repeat,
             count(*) FILTER (WHERE paid_orders = 0)::int  AS never_paid
        FROM per_customer
    `)),
  ];

  const [revenue] = [
    ...(await db.execute<{ first_cents: number; repeat_cents: number }>(sql`
      WITH ranked AS (
        SELECT o.customer_id,
               op.net_ex_vat_amount AS net,
               -- Ordered by when the money arrived, so "first purchase" means first PAID one,
               -- not the first order of any kind. A customer whose first order was a free issue
               -- still has a first purchase later.
               row_number() OVER (
                 PARTITION BY o.customer_id ORDER BY o.processed_at, o.id
               ) AS rn
          FROM orders o
          JOIN order_profit op ON op.order_id = o.id
         WHERE op.revenue_class = 'paid' AND o.customer_id IS NOT NULL
      )
      SELECT COALESCE(sum(net) FILTER (WHERE rn = 1), 0)::bigint AS first_cents,
             COALESCE(sum(net) FILTER (WHERE rn > 1), 0)::bigint AS repeat_cents
        FROM ranked
    `)),
  ];

  const first = n(revenue?.first_cents);
  const repeat = n(revenue?.repeat_cents);

  return {
    payingCustomers: n(counts?.paying),
    firstTimeOnly: n(counts?.first_only),
    repeatBuyers: n(counts?.repeat),
    repeatRate: share(n(counts?.repeat), n(counts?.paying)),
    neverPaid: n(counts?.never_paid),
    firstPurchaseCents: first,
    repeatPurchaseCents: repeat,
    repeatRevenueShare: share(repeat, first + repeat),
  };
}

/** How many paid purchases each customer has made, as a distribution. */
export async function getPurchaseFrequency(maxBucket = 6): Promise<FrequencyBucket[]> {
  const rows = await db.execute<{ paid_orders: number; customers: number }>(sql`
    WITH per_customer AS (
      SELECT o.customer_id,
             count(*) FILTER (WHERE op.revenue_class = 'paid') AS paid_orders
        FROM orders o
        JOIN order_profit op ON op.order_id = o.id
       WHERE o.customer_id IS NOT NULL
       GROUP BY 1
    )
    SELECT LEAST(paid_orders, ${maxBucket})::int AS paid_orders, count(*)::int AS customers
      FROM per_customer
     WHERE paid_orders >= 1
     GROUP BY 1
     ORDER BY 1
  `);

  return [...rows].map((r) => ({
    paidPurchases: n(r.paid_orders),
    customers: n(r.customers),
  }));
}

/**
 * For each way a customer was first acquired, how many went on to pay.
 *
 * This is the free-first-issue question: a gift that never converts is an acquisition cost with
 * nothing behind it, and one that converts at 40% is a bargain. Neither is knowable from order
 * counts.
 */
export async function getRouteConversions(): Promise<RouteConversion[]> {
  const rows = await db.execute<{
    route: string;
    customers: number;
    matured: number;
    ever_paid: number;
    repeat_buyers: number;
  }>(sql`
    WITH firsts AS (
      SELECT o.customer_id,
             op.revenue_class AS route,
             o.processed_at   AS acquired_at
        FROM orders o
        JOIN order_profit op ON op.order_id = o.id
       WHERE o.acquisition_order = true AND o.customer_id IS NOT NULL
    ),
    paid AS (
      SELECT o.customer_id,
             count(*) FILTER (WHERE op.revenue_class = 'paid') AS paid_orders
        FROM orders o
        JOIN order_profit op ON op.order_id = o.id
       WHERE o.customer_id IS NOT NULL
       GROUP BY 1
    )
    SELECT f.route,
           count(*)::int                                                       AS customers,
           count(*) FILTER (
             WHERE f.acquired_at < now() - (${MATURITY_DAYS} || ' days')::interval
           )::int                                                              AS matured,
           count(*) FILTER (
             WHERE f.acquired_at < now() - (${MATURITY_DAYS} || ' days')::interval
               AND COALESCE(p.paid_orders, 0) >= 1
           )::int                                                              AS ever_paid,
           count(*) FILTER (
             WHERE f.acquired_at < now() - (${MATURITY_DAYS} || ' days')::interval
               AND COALESCE(p.paid_orders, 0) >= 2
           )::int                                                              AS repeat_buyers
      FROM firsts f
      LEFT JOIN paid p ON p.customer_id = f.customer_id
     GROUP BY 1
     ORDER BY 2 DESC
  `);

  return [...rows].map((r) =>
    rateCohort({
      route: r.route as AcquisitionRoute,
      customers: n(r.customers),
      matured: n(r.matured),
      everPaid: n(r.ever_paid),
      repeatBuyers: n(r.repeat_buyers),
    }),
  );
}

export interface MonthlyTenure {
  month: string;
  firstPurchases: number;
  repeatPurchases: number;
  firstCents: number;
  repeatCents: number;
}

/**
 * The split month by month, so the mix can be seen moving.
 *
 * A single lifetime figure cannot distinguish "repeat buying is growing" from "we acquired a lot
 * of people three years ago", and those call for opposite decisions.
 */
export async function getMonthlyTenure(months = 12): Promise<MonthlyTenure[]> {
  const rows = await db.execute<{
    month: string;
    first_orders: number;
    repeat_orders: number;
    first_cents: number;
    repeat_cents: number;
  }>(sql`
    WITH ranked AS (
      SELECT o.customer_id,
             o.processed_at,
             op.net_ex_vat_amount AS net,
             row_number() OVER (
               PARTITION BY o.customer_id ORDER BY o.processed_at, o.id
             ) AS rn
        FROM orders o
        JOIN order_profit op ON op.order_id = o.id
       WHERE op.revenue_class = 'paid' AND o.customer_id IS NOT NULL
    )
    SELECT to_char(processed_at, 'YYYY-MM')                              AS month,
           count(*) FILTER (WHERE rn = 1)::int                           AS first_orders,
           count(*) FILTER (WHERE rn > 1)::int                           AS repeat_orders,
           COALESCE(sum(net) FILTER (WHERE rn = 1), 0)::bigint           AS first_cents,
           COALESCE(sum(net) FILTER (WHERE rn > 1), 0)::bigint           AS repeat_cents
      FROM ranked
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT ${months}
  `);

  return [...rows]
    .map((r) => ({
      month: r.month,
      firstPurchases: n(r.first_orders),
      repeatPurchases: n(r.repeat_orders),
      firstCents: n(r.first_cents),
      repeatCents: n(r.repeat_cents),
    }))
    .reverse();
}

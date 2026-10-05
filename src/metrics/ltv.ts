/**
 * Unified LTV and cohort analysis (Section 7 LTV + Section 9.4).
 *
 * This is the differentiator over stock StoreHero: value per customer summed
 * across BOTH money sources — Shopify orders (one-time and Skio subscription) and
 * Stripe invoices (print/digital) — keyed to one unified customer.
 *
 * Two things this module is careful about:
 *
 *  1. **Cohort windows must be comparable.** A cohort acquired last month cannot
 *     have 12 months of value yet, so reporting its 12-month LTV next to a
 *     year-old cohort's invites a false conclusion ("LTV is collapsing!"). Every
 *     cohort therefore carries `monthsObserved` and `isMature`, and the 12-month
 *     figure is null until the cohort has actually had 12 months.
 *
 *  2. **Comps are excluded from value but not from existence.** A customer who
 *     only ever received free copies has real cost and $0 revenue; including them
 *     in the LTV denominator would drag the average down as if paying customers
 *     were worth less. They're counted separately.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { predictiveSubscriptionLtv, ratio } from "./formulas";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
const num = (v: unknown): number => Number(v ?? 0);

/** Per-customer realised value across every source. */
const CUSTOMER_VALUE = sql`
  WITH shop AS (
    SELECT o.customer_id,
           sum(o.total_amount - o.total_refunded_amount) AS revenue,
           sum(CASE WHEN o.order_type = 'subscription_shopify'
                    THEN o.total_amount - o.total_refunded_amount ELSE 0 END) AS sub_revenue,
           sum(CASE WHEN o.order_type = 'one_time'
                    THEN o.total_amount - o.total_refunded_amount ELSE 0 END) AS onetime_revenue,
           count(*) AS orders,
           min(o.processed_at) AS first_order_at,
           max(o.processed_at) AS last_order_at
      FROM orders o
     WHERE o.test = false AND o.cancelled_at IS NULL
       AND o.counts_as_revenue = true AND o.customer_id IS NOT NULL
     GROUP BY o.customer_id
  ),
  strp AS (
    SELECT customer_id,
           sum(amount_paid_amount) AS paid,
           sum(CASE WHEN subscription_line = 'print' THEN amount_paid_amount ELSE 0 END) AS print_paid,
           sum(CASE WHEN subscription_line = 'digital' THEN amount_paid_amount ELSE 0 END) AS digital_paid,
           -- PAID invoices only: an abandoned-checkout invoice (voided, never charged —
           -- see churn.ts's SUBS_CTE) can predate the real one and misdate the cohort.
           min(invoiced_at) FILTER (WHERE paid) AS first_invoice_at
      FROM stripe_invoices WHERE customer_id IS NOT NULL
     GROUP BY customer_id
  )
  SELECT c.id AS customer_id,
         c.email,
         c.name,
         c.acquisition_channel,
         -- Acquisition date: earliest evidence from any source.
         LEAST(
           COALESCE(c.acquired_at, shop.first_order_at, strp.first_invoice_at),
           COALESCE(shop.first_order_at, strp.first_invoice_at, c.acquired_at),
           COALESCE(strp.first_invoice_at, shop.first_order_at, c.acquired_at)
         ) AS acquired_at,
         COALESCE(shop.revenue, 0)           AS shopify_revenue,
         COALESCE(shop.sub_revenue, 0)       AS skio_revenue,
         COALESCE(shop.onetime_revenue, 0)   AS onetime_revenue,
         COALESCE(strp.print_paid, 0)        AS stripe_print_revenue,
         COALESCE(strp.digital_paid, 0)      AS stripe_digital_revenue,
         COALESCE(shop.revenue, 0) + COALESCE(strp.paid, 0) AS total_value,
         COALESCE(shop.orders, 0)            AS orders,
         shop.last_order_at,
         EXISTS (SELECT 1 FROM subscription_meta sm WHERE sm.customer_id = c.id) AS has_skio,
         EXISTS (SELECT 1 FROM stripe_subscriptions ss WHERE ss.customer_id = c.id) AS has_stripe
    FROM customers c
    LEFT JOIN shop ON shop.customer_id = c.id
    LEFT JOIN strp ON strp.customer_id = c.id
`;

export interface CohortRow {
  cohortMonth: string; // YYYY-MM
  customers: number;
  /** Customers who never generated revenue (comp-only). Excluded from LTV. */
  zeroValueCustomers: number;
  monthsObserved: number;
  isMature: boolean; // has had a full 12 months
  totalValueCents: number;
  ltvCents: number | null;
  /** Null until the cohort has actually been observed for 12 months. */
  ltv12MonthCents: number | null;
  /**
   * LTV counting only the first 3 months after each customer's acquisition.
   *
   * This is the column to trend. Raw LTV rises with cohort age purely because older
   * cohorts have had longer to accumulate, so reading the raw column top-to-bottom
   * looks like "LTV is collapsing" when it's just the observation window shrinking.
   * A fixed young window every cohort has completed makes them comparable.
   */
  ltvAt3MonthsCents: number | null;
  shopifyValueCents: number;
  skioValueCents: number;
  stripePrintValueCents: number;
  stripeDigitalValueCents: number;
  subscriberPct: number | null;
}

/**
 * LTV by acquisition month, broken out by revenue source.
 *
 * `ltv12MonthCents` is computed only over value collected within 12 months of each
 * customer's own acquisition date, and only reported once the cohort is mature —
 * this is the brief's primary LTV number and the one worth trending.
 */
export async function getCohorts(): Promise<CohortRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH cv AS (${CUSTOMER_VALUE}),
    -- Value collected within N months of that customer's own acquisition date.
    windows AS (
      SELECT cv.customer_id,
             COALESCE((
               SELECT sum(o.total_amount - o.total_refunded_amount)
                 FROM orders o
                WHERE o.customer_id = cv.customer_id
                  AND o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
                  AND o.processed_at < cv.acquired_at + interval '12 months'
             ), 0)
             + COALESCE((
               SELECT sum(i.amount_paid_amount) FROM stripe_invoices i
                WHERE i.customer_id = cv.customer_id
                  AND i.invoiced_at < cv.acquired_at + interval '12 months'
             ), 0) AS value_12m,
             COALESCE((
               SELECT sum(o.total_amount - o.total_refunded_amount)
                 FROM orders o
                WHERE o.customer_id = cv.customer_id
                  AND o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
                  AND o.processed_at < cv.acquired_at + interval '3 months'
             ), 0)
             + COALESCE((
               SELECT sum(i.amount_paid_amount) FROM stripe_invoices i
                WHERE i.customer_id = cv.customer_id
                  AND i.invoiced_at < cv.acquired_at + interval '3 months'
             ), 0) AS value_3m
        FROM cv WHERE cv.acquired_at IS NOT NULL
    )
    SELECT to_char(date_trunc('month', cv.acquired_at), 'YYYY-MM') AS cohort_month,
           count(*)                                        AS customers,
           count(*) FILTER (WHERE cv.total_value = 0)       AS zero_value_customers,
           sum(cv.total_value)                             AS total_value,
           sum(cv.shopify_revenue)                         AS shopify_value,
           sum(cv.skio_revenue)                            AS skio_value,
           sum(cv.stripe_print_revenue)                    AS stripe_print_value,
           sum(cv.stripe_digital_revenue)                  AS stripe_digital_value,
           sum(windows.value_12m)                          AS value_12m,
           sum(windows.value_3m)                           AS value_3m,
           count(*) FILTER (WHERE cv.has_skio OR cv.has_stripe) AS subscribers,
           -- Whole months from the cohort month to now.
           (EXTRACT(YEAR FROM age(date_trunc('month', now()), date_trunc('month', cv.acquired_at))) * 12
            + EXTRACT(MONTH FROM age(date_trunc('month', now()), date_trunc('month', cv.acquired_at))))::int
             AS months_observed
      FROM cv
      LEFT JOIN windows ON windows.customer_id = cv.customer_id
     WHERE cv.acquired_at IS NOT NULL
     GROUP BY 1, months_observed
     ORDER BY 1
  `);

  return data.map((r) => {
    const customers = num(r.customers);
    const zero = num(r.zero_value_customers);
    const paying = customers - zero;
    const monthsObserved = num(r.months_observed);
    const isMature = monthsObserved >= 12;
    return {
      cohortMonth: String(r.cohort_month),
      customers,
      zeroValueCustomers: zero,
      monthsObserved,
      isMature,
      totalValueCents: num(r.total_value),
      // LTV over PAYING customers — comp-only recipients would drag it down.
      ltvCents: ratio(num(r.total_value), paying),
      ltv12MonthCents: isMature ? ratio(num(r.value_12m), paying) : null,
      // Only meaningful once the cohort has completed the 3-month window.
      ltvAt3MonthsCents: monthsObserved >= 3 ? ratio(num(r.value_3m), paying) : null,
      shopifyValueCents: num(r.shopify_value),
      skioValueCents: num(r.skio_value),
      stripePrintValueCents: num(r.stripe_print_value),
      stripeDigitalValueCents: num(r.stripe_digital_value),
      subscriberPct: ratio(num(r.subscribers), customers),
    };
  });
}

export interface ChannelLtvRow {
  channel: string;
  customers: number;
  totalValueCents: number;
  ltvCents: number | null;
  subscriberPct: number | null;
  avgOrders: number | null;
}

/** LTV by acquisition channel — which channels bring customers worth having. */
export async function getLtvByChannel(): Promise<ChannelLtvRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH cv AS (${CUSTOMER_VALUE})
    SELECT COALESCE(cv.acquisition_channel, '(unattributed)') AS channel,
           count(*) AS customers,
           count(*) FILTER (WHERE cv.total_value > 0) AS paying,
           sum(cv.total_value) AS total_value,
           count(*) FILTER (WHERE cv.has_skio OR cv.has_stripe) AS subscribers,
           avg(cv.orders) AS avg_orders
      FROM cv
     GROUP BY 1
     ORDER BY sum(cv.total_value) DESC
  `);

  return data.map((r) => ({
    channel: String(r.channel),
    customers: num(r.customers),
    totalValueCents: num(r.total_value),
    ltvCents: ratio(num(r.total_value), num(r.paying)),
    subscriberPct: ratio(num(r.subscribers), num(r.customers)),
    avgOrders: num(r.avg_orders) || null,
  }));
}

export interface SubscriptionRetention {
  source: "skio" | "stripe";
  total: number;
  active: number;
  canceled: number;
  churnRatePct: number | null;
  /** Average completed billing cycles before cancellation. */
  avgLifetimeMonths: number | null;
  mrrCents: number;
  predictiveLtvCents: number | null;
}

/**
 * Retention/churn per subscription system, plus predictive LTV.
 *
 * Churn here is cumulative (cancelled ÷ ever-started), not monthly — with under a
 * year of Skio history a monthly rate would swing wildly. The monthly rate used
 * for predictive LTV is derived from cumulative churn spread over the observed
 * window, and the window is stated so the number isn't mistaken for precision.
 */
export async function getSubscriptionRetention(): Promise<SubscriptionRetention[]> {
  const [skio] = await rows<Record<string, unknown>>(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE status = 'active') AS active,
           count(*) FILTER (WHERE status = 'canceled') AS canceled,
           COALESCE(sum(mrr_amount) FILTER (WHERE status = 'active'), 0) AS mrr,
           COALESCE(avg(EXTRACT(EPOCH FROM (COALESCE(cancelled_at, now()) - started_at)) / 2629800.0), 0) AS avg_months
      FROM subscription_meta WHERE started_at IS NOT NULL
  `);
  const [stripe] = await rows<Record<string, unknown>>(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE status = 'active') AS active,
           count(*) FILTER (WHERE status = 'canceled') AS canceled,
           COALESCE(sum(mrr_amount) FILTER (WHERE status = 'active'), 0) AS mrr,
           COALESCE(avg(EXTRACT(EPOCH FROM (COALESCE(canceled_at, now()) - started_at)) / 2629800.0), 0) AS avg_months
      FROM stripe_subscriptions
     WHERE started_at IS NOT NULL AND status != 'expired'
  `);

  const build = (r: Record<string, unknown>, source: "skio" | "stripe"): SubscriptionRetention => {
    const total = num(r.total);
    const canceled = num(r.canceled);
    const active = num(r.active);
    const avgMonths = num(r.avg_months);
    const cumulativeChurn = ratio(canceled, total);
    // Convert cumulative churn over the observed lifetime into a monthly rate.
    const monthlyChurn =
      cumulativeChurn != null && avgMonths > 0 ? cumulativeChurn / avgMonths : null;
    const mrr = num(r.mrr);
    const mrrPerActive = active > 0 ? Math.round(mrr / active) : 0;
    return {
      source,
      total,
      active,
      canceled,
      churnRatePct: cumulativeChurn,
      avgLifetimeMonths: avgMonths || null,
      mrrCents: mrr,
      predictiveLtvCents:
        monthlyChurn != null && mrrPerActive > 0
          ? predictiveSubscriptionLtv(mrrPerActive, monthlyChurn)
          : null,
    };
  };

  return [build(skio, "skio"), build(stripe, "stripe")];
}

export interface RetentionCurvePoint {
  monthsSinceStart: number;
  skioRetainedPct: number | null;
  stripeRetainedPct: number | null;
}

/**
 * Survival curve: share of subscriptions still active N months after starting.
 * Only counts subscriptions old enough to have reached month N, so the curve
 * doesn't dive artificially at the right edge from young subscriptions.
 */
export async function getRetentionCurve(maxMonths = 12): Promise<RetentionCurvePoint[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH months AS (SELECT generate_series(0, ${maxMonths}) AS m),
    skio AS (
      SELECT started_at, cancelled_at,
             EXTRACT(EPOCH FROM (now() - started_at)) / 2629800.0 AS age_months,
             EXTRACT(EPOCH FROM (COALESCE(cancelled_at, now()) - started_at)) / 2629800.0 AS lived_months
        FROM subscription_meta WHERE started_at IS NOT NULL
    ),
    strp AS (
      SELECT started_at, canceled_at,
             EXTRACT(EPOCH FROM (now() - started_at)) / 2629800.0 AS age_months,
             EXTRACT(EPOCH FROM (COALESCE(canceled_at, now()) - started_at)) / 2629800.0 AS lived_months
        FROM stripe_subscriptions
       WHERE started_at IS NOT NULL AND status != 'expired'
    )
    SELECT months.m AS months_since_start,
           (SELECT count(*) FILTER (WHERE lived_months >= months.m)::float
                     / NULLIF(count(*) FILTER (WHERE age_months >= months.m), 0)
              FROM skio) AS skio_pct,
           (SELECT count(*) FILTER (WHERE lived_months >= months.m)::float
                     / NULLIF(count(*) FILTER (WHERE age_months >= months.m), 0)
              FROM strp) AS stripe_pct
      FROM months ORDER BY months.m
  `);

  return data.map((r) => ({
    monthsSinceStart: num(r.months_since_start),
    skioRetainedPct: r.skio_pct == null ? null : Number(r.skio_pct),
    stripeRetainedPct: r.stripe_pct == null ? null : Number(r.stripe_pct),
  }));
}

export interface LtvSummary {
  customersWithValue: number;
  customersZeroValue: number;
  totalValueCents: number;
  blendedLtvCents: number | null;
  subscriberLtvCents: number | null;
  nonSubscriberLtvCents: number | null;
  /** How much more a subscriber is worth than a one-time buyer. */
  subscriberMultiple: number | null;
}

export async function getLtvSummary(): Promise<LtvSummary> {
  const [r] = await rows<Record<string, unknown>>(sql`
    WITH cv AS (${CUSTOMER_VALUE})
    SELECT count(*) FILTER (WHERE total_value > 0) AS with_value,
           count(*) FILTER (WHERE total_value = 0) AS zero_value,
           COALESCE(sum(total_value), 0) AS total_value,
           COALESCE(sum(total_value) FILTER (WHERE has_skio OR has_stripe), 0) AS sub_value,
           count(*) FILTER (WHERE (has_skio OR has_stripe) AND total_value > 0) AS sub_customers,
           COALESCE(sum(total_value) FILTER (WHERE NOT (has_skio OR has_stripe)), 0) AS nonsub_value,
           count(*) FILTER (WHERE NOT (has_skio OR has_stripe) AND total_value > 0) AS nonsub_customers
      FROM cv
  `);

  const blended = ratio(num(r.total_value), num(r.with_value));
  const subLtv = ratio(num(r.sub_value), num(r.sub_customers));
  const nonSubLtv = ratio(num(r.nonsub_value), num(r.nonsub_customers));

  return {
    customersWithValue: num(r.with_value),
    customersZeroValue: num(r.zero_value),
    totalValueCents: num(r.total_value),
    blendedLtvCents: blended,
    subscriberLtvCents: subLtv,
    nonSubscriberLtvCents: nonSubLtv,
    subscriberMultiple:
      subLtv != null && nonSubLtv != null && nonSubLtv > 0 ? subLtv / nonSubLtv : null,
  };
}

/**
 * Overview metrics — queried live from raw tables for now.
 *
 * Revenue rules (Section 3, enforced in every query here):
 *  - Shopify order revenue counts only `counts_as_revenue = true` orders, which
 *    excludes Stripe/Craft fulfillment proxies and unreviewed no-payment orders.
 *    A reviewer's `review_override` decision is already folded into that flag.
 *  - Test and cancelled orders are always excluded.
 *  - Stripe is additive and separate: realised revenue = paid invoice amounts.
 *  - Skio contributes NO revenue — only subscription/churn/MRR context.
 *
 * Phase 6 will materialise these into `daily_metrics`; the dashboard already
 * reads through this module, so that swap won't touch the UI.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";

/** Shared predicate for countable Shopify order revenue. */
const COUNTABLE = sql`test = false AND cancelled_at IS NULL AND counts_as_revenue = true`;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return result as unknown as T[];
}

const num = (v: unknown): number => Number(v ?? 0);

export interface RevenueSummary {
  shopifyGrossCents: number;
  shopifyRefundsCents: number;
  shopifyNetCents: number;
  stripePaidCents: number;
  combinedNetCents: number;
  orderCount: number;
  /** Orders with a non-zero value — the AOV denominator. */
  paidOrderCount: number;
  /**
   * Orders totalling $0: subsequent deliveries on prepaid subscription plans
   * (e.g. annual-paid, quarterly-delivered) plus comps/VIP copies. They are
   * fulfillment events, not sales, so they are excluded from AOV — including
   * them would understate it badly (65% of orders here are $0).
   */
  zeroValueOrderCount: number;
  aovCents: number;
  customerCount: number;
  newCustomerRevenueCents: number;
  firstOrderDate: string | null;
  lastOrderDate: string | null;
}

/**
 * `since`/`until` are optional (inclusive, `YYYY-MM-DD`) so this keeps working
 * unfiltered for its all-time callers (the AI analyst, `/costs`' data-bounds
 * lookup) while the overview page can scope it to whatever's picked in the
 * `DateRangePicker`.
 */
export async function getRevenueSummary(since?: string, until?: string): Promise<RevenueSummary> {
  const dateFilter = since && until ? sql`AND processed_at::date BETWEEN ${since} AND ${until}` : sql``;
  const stripeDateFilter =
    since && until ? sql`AND invoiced_at::date BETWEEN ${since} AND ${until}` : sql``;

  const [shopify] = await rows<Record<string, unknown>>(sql`
    SELECT
      COALESCE(sum(total_amount), 0)          AS gross,
      COALESCE(sum(total_refunded_amount), 0) AS refunds,
      count(*)                                AS orders,
      count(*) FILTER (WHERE total_amount > 0)  AS paid_orders,
      count(*) FILTER (WHERE total_amount = 0)  AS zero_orders,
      min(processed_at)::date::text           AS first_date,
      max(processed_at)::date::text           AS last_date,
      COALESCE(sum(total_amount) FILTER (WHERE acquisition_order), 0) AS new_cust_revenue
    FROM orders WHERE ${COUNTABLE} ${dateFilter}
  `);

  const [stripe] = await rows<Record<string, unknown>>(sql`
    SELECT COALESCE(sum(amount_paid_amount), 0) AS paid FROM stripe_invoices WHERE true ${stripeDateFilter}
  `);

  const [cust] = await rows<Record<string, unknown>>(sql`
    SELECT count(*) AS n FROM customers
  `);

  const gross = num(shopify.gross);
  const refunds = num(shopify.refunds);
  const net = gross - refunds;
  const stripePaid = num(stripe.paid);
  const orderCount = num(shopify.orders);
  const paidOrderCount = num(shopify.paid_orders);

  return {
    shopifyGrossCents: gross,
    shopifyRefundsCents: refunds,
    shopifyNetCents: net,
    stripePaidCents: stripePaid,
    combinedNetCents: net + stripePaid,
    orderCount,
    paidOrderCount,
    zeroValueOrderCount: num(shopify.zero_orders),
    // AOV over PAID orders only — $0 fulfillment shipments aren't sales.
    aovCents: paidOrderCount ? Math.round(gross / paidOrderCount) : 0,
    customerCount: num(cust.n),
    newCustomerRevenueCents: num(shopify.new_cust_revenue),
    firstOrderDate: (shopify.first_date as string) ?? null,
    lastOrderDate: (shopify.last_date as string) ?? null,
  };
}

export interface MonthlyPoint {
  month: string; // YYYY-MM
  shopifyNetCents: number;
  stripePaidCents: number;
  orders: number;
}

/**
 * Combined monthly revenue series across both money sources. Unfiltered by default
 * (the trend behind the headline numbers); pass `since`/`until` to scope it to the
 * same window as the rest of the page — with a short window (e.g. "7 days") this
 * naturally collapses to one partial-month bar, which is correct, not a bug.
 */
export async function getMonthlyRevenue(since?: string, until?: string): Promise<MonthlyPoint[]> {
  const dateFilter = since && until ? sql`AND processed_at::date BETWEEN ${since} AND ${until}` : sql``;
  const stripeDateFilter =
    since && until ? sql`AND invoiced_at::date BETWEEN ${since} AND ${until}` : sql``;
  const data = await rows<Record<string, unknown>>(sql`
    WITH shop AS (
      SELECT to_char(date_trunc('month', processed_at), 'YYYY-MM') AS m,
             sum(total_amount - total_refunded_amount) AS net,
             count(*) AS orders
      FROM orders
      WHERE ${COUNTABLE} AND processed_at IS NOT NULL ${dateFilter}
      GROUP BY 1
    ),
    stripe AS (
      SELECT to_char(date_trunc('month', invoiced_at), 'YYYY-MM') AS m,
             sum(amount_paid_amount) AS paid
      FROM stripe_invoices
      WHERE invoiced_at IS NOT NULL ${stripeDateFilter}
      GROUP BY 1
    )
    SELECT COALESCE(shop.m, stripe.m) AS month,
           COALESCE(shop.net, 0)      AS shopify_net,
           COALESCE(stripe.paid, 0)   AS stripe_paid,
           COALESCE(shop.orders, 0)   AS orders
    FROM shop FULL OUTER JOIN stripe ON shop.m = stripe.m
    ORDER BY 1
  `);

  return data.map((r) => ({
    month: String(r.month),
    shopifyNetCents: num(r.shopify_net),
    stripePaidCents: num(r.stripe_paid),
    orders: num(r.orders),
  }));
}

export interface OrderMix {
  orderType: string;
  orders: number;
  netCents: number;
}

/** Revenue split by order type (one-time vs Skio subscription). */
export async function getOrderMix(since?: string, until?: string): Promise<OrderMix[]> {
  const dateFilter = since && until ? sql`AND processed_at::date BETWEEN ${since} AND ${until}` : sql``;
  const data = await rows<Record<string, unknown>>(sql`
    SELECT order_type,
           count(*) AS orders,
           sum(total_amount - total_refunded_amount) AS net
    FROM orders WHERE ${COUNTABLE} ${dateFilter}
    GROUP BY 1 ORDER BY 3 DESC
  `);
  return data.map((r) => ({
    orderType: String(r.order_type),
    orders: num(r.orders),
    netCents: num(r.net),
  }));
}

export interface SubscriptionHealth {
  skioActive: number;
  skioCanceled: number;
  skioTotal: number;
  skioMrrCents: number;
  stripeActive: number;
  stripeCanceled: number;
  stripeTotal: number;
  stripeMrrCents: number;
  combinedMrrCents: number;
}

export async function getSubscriptionHealth(): Promise<SubscriptionHealth> {
  const [skio] = await rows<Record<string, unknown>>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'active')   AS active,
      count(*) FILTER (WHERE status = 'canceled') AS canceled,
      count(*)                                    AS total,
      COALESCE(sum(mrr_amount) FILTER (WHERE status = 'active'), 0) AS mrr
    FROM subscription_meta
  `);
  const [stripe] = await rows<Record<string, unknown>>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'active')   AS active,
      count(*) FILTER (WHERE status = 'canceled') AS canceled,
      count(*)                                    AS total,
      COALESCE(sum(mrr_amount) FILTER (WHERE status = 'active'), 0) AS mrr
    FROM stripe_subscriptions
  `);

  const skioMrr = num(skio.mrr);
  const stripeMrr = num(stripe.mrr);
  return {
    skioActive: num(skio.active),
    skioCanceled: num(skio.canceled),
    skioTotal: num(skio.total),
    skioMrrCents: skioMrr,
    stripeActive: num(stripe.active),
    stripeCanceled: num(stripe.canceled),
    stripeTotal: num(stripe.total),
    stripeMrrCents: stripeMrr,
    combinedMrrCents: skioMrr + stripeMrr,
  };
}

export interface DataQuality {
  excludedFulfillmentOrders: number;
  excludedFulfillmentNominalCents: number;
  pendingReviewOrders: number;
  pendingReviewCents: number;
  linkedSubscriptionOrders: number;
  lineItemsMissingCogs: number;
  totalLineItems: number;
  lastSyncs: Array<{ source: string; status: string; finishedAt: string | null; rows: number }>;
}

/**
 * Transparency panel — never let a number look clean when it isn't (Section 5).
 * COGS coverage is reported here so margin can't be silently wrong later.
 */
export async function getDataQuality(): Promise<DataQuality> {
  const [fulfil] = await rows<Record<string, unknown>>(sql`
    SELECT count(*) AS n, COALESCE(sum(total_amount), 0) AS nominal
    FROM orders WHERE order_type = 'subscription_stripe_fulfillment'
  `);
  const [review] = await rows<Record<string, unknown>>(sql`
    SELECT count(*) AS n, COALESCE(sum(total_amount), 0) AS value
    FROM orders WHERE needs_review = true AND review_override IS NULL
  `);
  const [linked] = await rows<Record<string, unknown>>(sql`
    SELECT count(*) AS n FROM orders WHERE subscription_meta_id IS NOT NULL
  `);
  const [cogs] = await rows<Record<string, unknown>>(sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (
        WHERE li.sku IS NULL OR NOT EXISTS (
          SELECT 1 FROM product_costs pc WHERE pc.sku = li.sku
        )
      ) AS missing
    FROM order_line_items li
  `);
  const syncs = await rows<Record<string, unknown>>(sql`
    SELECT DISTINCT ON (source) source, status, rows_upserted,
           to_char(finished_at, 'YYYY-MM-DD HH24:MI') AS finished
    FROM sync_runs ORDER BY source, started_at DESC
  `);

  return {
    excludedFulfillmentOrders: num(fulfil.n),
    excludedFulfillmentNominalCents: num(fulfil.nominal),
    pendingReviewOrders: num(review.n),
    pendingReviewCents: num(review.value),
    linkedSubscriptionOrders: num(linked.n),
    lineItemsMissingCogs: num(cogs.missing),
    totalLineItems: num(cogs.total),
    lastSyncs: syncs.map((s) => ({
      source: String(s.source),
      status: String(s.status),
      finishedAt: (s.finished as string) ?? null,
      rows: num(s.rows_upserted),
    })),
  };
}

export interface TopCustomer {
  name: string | null;
  email: string | null;
  orders: number;
  shopifyNetCents: number;
  stripePaidCents: number;
  totalCents: number;
  isSubscriber: boolean;
}

/**
 * Unified LTV leaderboard — the differentiator over stock StoreHero: value per
 * customer summed across Shopify orders AND Stripe invoices.
 *
 * Unfiltered by default (all-time LTV); pass `since`/`until` to rank by revenue
 * within a window instead — e.g. "who mattered most this month" rather than
 * "who has spent the most ever".
 */
export async function getTopCustomers(
  limit = 10,
  since?: string,
  until?: string,
): Promise<TopCustomer[]> {
  const dateFilter = since && until ? sql`AND processed_at::date BETWEEN ${since} AND ${until}` : sql``;
  const stripeDateFilter =
    since && until ? sql`AND invoiced_at::date BETWEEN ${since} AND ${until}` : sql``;
  const data = await rows<Record<string, unknown>>(sql`
    WITH shop AS (
      SELECT customer_id,
             sum(total_amount - total_refunded_amount) AS net,
             count(*) AS orders
      FROM orders WHERE ${COUNTABLE} AND customer_id IS NOT NULL ${dateFilter}
      GROUP BY 1
    ),
    strp AS (
      SELECT customer_id, sum(amount_paid_amount) AS paid
      FROM stripe_invoices WHERE customer_id IS NOT NULL ${stripeDateFilter}
      GROUP BY 1
    )
    SELECT c.name, c.email,
           COALESCE(shop.orders, 0) AS orders,
           COALESCE(shop.net, 0)    AS shopify_net,
           COALESCE(strp.paid, 0)   AS stripe_paid,
           COALESCE(shop.net, 0) + COALESCE(strp.paid, 0) AS total,
           EXISTS (SELECT 1 FROM subscription_meta sm WHERE sm.customer_id = c.id)
             OR EXISTS (SELECT 1 FROM stripe_subscriptions ss WHERE ss.customer_id = c.id)
             AS is_subscriber
    FROM customers c
    LEFT JOIN shop ON shop.customer_id = c.id
    LEFT JOIN strp ON strp.customer_id = c.id
    WHERE COALESCE(shop.net, 0) + COALESCE(strp.paid, 0) > 0
    ORDER BY total DESC
    LIMIT ${limit}
  `);

  return data.map((r) => ({
    name: (r.name as string) ?? null,
    email: (r.email as string) ?? null,
    orders: num(r.orders),
    shopifyNetCents: num(r.shopify_net),
    stripePaidCents: num(r.stripe_paid),
    totalCents: num(r.total),
    isSubscriber: Boolean(r.is_subscriber),
  }));
}

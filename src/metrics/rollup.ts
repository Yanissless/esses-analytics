/**
 * daily_metrics rollup (Section 6/9).
 *
 * The dashboard must never recompute from raw rows on page load, so this
 * materialises one row per (date, channel) — with `channel = NULL` meaning the
 * blended, all-channels view.
 *
 * What goes in:
 *  - Shopify order revenue, restricted to countable orders (excludes Stripe/Craft
 *    fulfilment proxies and unreviewed no-payment orders) and split paid vs comp.
 *  - Stripe invoice revenue, additive and separate.
 *  - COGS resolved at the cost effective on the order date, by fulfilment origin.
 *  - Shipping cost preferring the actual invoice, then rate rule, then zone.
 *  - Ad spend from ad_spend.
 *
 * Channel attribution proper arrives in Phase 7; until then ad spend is attributed
 * to its platform channel and revenue sits on the blended row, which is why
 * channel-level ROAS stays null rather than guessing.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { logger } from "../lib/logger";
import {
  amer,
  aov,
  cac,
  contributionMargin,
  mer,
  ratio,
} from "./formulas";
import { rebuildOrderProfit } from "./order-profit";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
const num = (v: unknown): number => Number(v ?? 0);

export interface RollupResult {
  daysComputed: number;
  channelRows: number;
  firstDate: string | null;
  lastDate: string | null;
}

/**
 * Per-day revenue/cost aggregates. Mirrors the cost resolution in metrics/cogs.ts
 * (actual shipping > rate rule > zone estimate; origin-aware, date-effective COGS)
 * so the rollup and the international view can never disagree.
 */
const DAILY_SOURCE = sql`
  WITH ord AS (
    SELECT o.id, o.processed_at::date AS d,
           o.total_amount, o.total_refunded_amount, o.total_discounts_amount,
           o.shipping_amount, o.acquisition_order, o.customer_id,
           o.order_type, o.subscription_meta_id,
           COALESCE(o.shipping_country, o.billing_country) AS country,
           o.fulfillment_origin_override,
           (o.customer_id IS NOT NULL AND (
              EXISTS (SELECT 1 FROM subscription_meta sm WHERE sm.customer_id = o.customer_id)
              OR EXISTS (SELECT 1 FROM stripe_subscriptions ss WHERE ss.customer_id = o.customer_id)
           )) AS customer_has_subscription
      FROM orders o
     WHERE o.test = false AND o.cancelled_at IS NULL
       AND o.counts_as_revenue = true AND o.processed_at IS NOT NULL
  ),
  ord_mkt AS (
    SELECT ord.*,
           COALESCE(ord.fulfillment_origin_override, mc.fulfillment_origin, 'US') AS origin,
           COALESCE(mc.shipping_zone, 'row') AS zone,
           CASE WHEN mc.vat_basis = 'standard' THEN mc.std_vat_pct
                ELSE COALESCE(mc.print_vat_pct, 0) END AS vat_pct,
           -- Must match metrics/order-profit.ts exactly. A $0 order for a customer
           -- who holds a subscription is a prepaid delivery, not a free copy.
           CASE WHEN ord.total_amount > 0 THEN 'paid'
                WHEN ord.subscription_meta_id IS NOT NULL
                     OR ord.order_type = 'subscription_shopify' THEN 'prepaid_delivery'
                WHEN ord.customer_has_subscription THEN 'prepaid_delivery'
                ELSE 'comp' END AS revenue_class
      FROM ord
      LEFT JOIN market_config mc ON mc.country_code = ord.country
  ),
  line_costs AS (
    SELECT li.order_id,
           sum(li.quantity) AS units,
           sum(li.quantity * COALESCE(
             (SELECT pc.cost_amount FROM product_costs pc
               WHERE pc.sku = li.sku AND pc.origin = om.origin
                 AND pc.effective_date <= om.d
               ORDER BY pc.effective_date DESC LIMIT 1),
             (SELECT pc.cost_amount FROM product_costs pc
               WHERE pc.sku = li.sku AND pc.origin = 'default'
                 AND pc.effective_date <= om.d
               ORDER BY pc.effective_date DESC LIMIT 1),
             (SELECT pc.cost_amount FROM product_costs pc
               WHERE pc.sku = 'variant:' || li.variant_id::text
                 AND pc.effective_date <= om.d
               ORDER BY pc.effective_date DESC LIMIT 1),
             0)) AS cogs,
           sum(CASE WHEN NOT EXISTS (
                 SELECT 1 FROM product_costs pc
                  WHERE (pc.sku = li.sku
                         OR pc.sku = 'variant:' || li.variant_id::text
                         OR pc.variant_id = li.variant_id)
                    AND pc.effective_date <= om.d
               ) THEN li.quantity ELSE 0 END) AS uncosted_units
      FROM order_line_items li
      JOIN ord_mkt om ON om.id = li.order_id
     GROUP BY li.order_id
  ),
  zone_costs AS (
    SELECT om.id AS order_id, ca.ship_cost_amount, ca.freight_per_unit_amount,
           ca.packaging_amount, ca.pick_pack_amount, ca.processing_pct,
           ca.return_rate_pct, ca.return_cost_amount
      FROM ord_mkt om
      LEFT JOIN LATERAL (
        SELECT * FROM cost_assumptions c
         WHERE c.zone = om.zone AND c.effective_date <= om.d
         ORDER BY c.effective_date DESC LIMIT 1
      ) ca ON true
  ),
  actual_ship AS (
    SELECT order_id,
           sum(ship_amount + surcharge_amount) AS ship_actual,
           sum(duties_amount) AS duties_actual
      FROM shipping_charges WHERE order_id IS NOT NULL GROUP BY order_id
  ),
  rate_est AS (
    SELECT f.order_id,
           sum((SELECT rr.expected_cost_amount FROM shipping_rate_rules rr
                 WHERE (rr.carrier_pattern IS NULL
                         OR lower(coalesce(f.tracking_company,'')) LIKE '%' || lower(rr.carrier_pattern) || '%')
                   AND (rr.country_code IS NULL OR rr.country_code = om.country)
                   -- Must stay identical to order-profit.ts's rate_est.
                   AND (rr.exclude_country_code IS NULL
                         OR rr.exclude_country_code <> COALESCE(om.country, ''))
                   AND (rr.zone IS NULL OR rr.zone = om.zone)
                   AND rr.effective_date <= COALESCE(f.shipped_at::date, om.d)
                 ORDER BY rr.priority DESC, rr.effective_date DESC LIMIT 1)) AS ship_rate
      FROM fulfillments f JOIN ord_mkt om ON om.id = f.order_id
     GROUP BY f.order_id
  ),
  per_order AS (
    SELECT om.d, om.revenue_class, om.acquisition_order, om.customer_id,
           om.total_amount, om.total_refunded_amount, om.total_discounts_amount,
           ROUND((om.total_amount - om.total_refunded_amount) / (1 + COALESCE(om.vat_pct, 0)))::bigint AS net_ex_vat,
           COALESCE(lc.units, 0) AS units,
           COALESCE(lc.cogs, 0) AS cogs,
           COALESCE(lc.uncosted_units, 0) AS uncosted_units,
           COALESCE(asx.ship_actual, re.ship_rate, zc.ship_cost_amount, 0) AS ship_cost,
           COALESCE(asx.duties_actual, 0) AS duties_cost,
           COALESCE(lc.units, 0) * COALESCE(zc.freight_per_unit_amount, 0)
             + COALESCE(zc.packaging_amount, 0) + COALESCE(zc.pick_pack_amount, 0)
             + ROUND(COALESCE(zc.return_rate_pct,0) * COALESCE(zc.return_cost_amount,0))::bigint AS other_fulfil,
           ROUND(om.total_amount * COALESCE(zc.processing_pct, 0))::bigint AS processing
      FROM ord_mkt om
      LEFT JOIN line_costs lc ON lc.order_id = om.id
      LEFT JOIN zone_costs zc ON zc.order_id = om.id
      LEFT JOIN actual_ship asx ON asx.order_id = om.id
      LEFT JOIN rate_est re ON re.order_id = om.id
  ),
  shop_daily AS (
    SELECT d,
           sum(total_amount) FILTER (WHERE revenue_class = 'paid') AS gross,
           sum(net_ex_vat)                                          AS net_ex_vat,
           sum(total_refunded_amount)                               AS refunds,
           sum(total_discounts_amount)                              AS discounts,
           count(*) FILTER (WHERE revenue_class <> 'comp')          AS orders,
           count(*) FILTER (WHERE total_amount > 0)                 AS paid_orders,
           count(*) FILTER (WHERE acquisition_order)                AS new_customers,
           -- REPEAT ORDERS, not distinct customers. Distinct-per-day counts don't
           -- sum across days (a customer ordering twice in a period would be
           -- counted twice), so storing an additive measure keeps period totals
           -- honest. new_customers IS additive: each customer is new exactly once.
           count(*) FILTER (WHERE NOT acquisition_order)            AS returning_orders,
           sum(total_amount) FILTER (WHERE acquisition_order)        AS new_cust_revenue,
           sum(cogs) FILTER (WHERE revenue_class = 'paid') AS cogs,
           sum(ship_cost + duties_cost) FILTER (WHERE revenue_class = 'paid') AS shipping,
           sum(other_fulfil) FILTER (WHERE revenue_class = 'paid') AS other_fulfil,
           sum(processing) FILTER (WHERE revenue_class = 'paid') AS processing,
           sum(uncosted_units) FILTER (WHERE revenue_class = 'paid') AS uncosted_units,
           count(*) FILTER (WHERE revenue_class <> 'comp' AND uncosted_units > 0) AS uncosted_orders,
           sum(cogs + ship_cost + other_fulfil) FILTER (WHERE revenue_class = 'comp') AS comp_cost,
           -- Cost of shipping issues already paid for on an earlier order. Real cash
           -- out, but its revenue was recognised in a previous period, so it sits
           -- outside CM rather than inside it.
           sum(cogs + ship_cost + duties_cost + other_fulfil)
             FILTER (WHERE revenue_class = 'prepaid_delivery') AS prepaid_cost
      FROM per_order GROUP BY d
  ),
  stripe_daily AS (
    SELECT invoiced_at::date AS d, sum(amount_paid_amount) AS paid
      FROM stripe_invoices WHERE invoiced_at IS NOT NULL GROUP BY 1
  ),
  spend_daily AS (
    SELECT date AS d, sum(spend_amount) AS spend
      FROM ad_spend GROUP BY 1
  )
  SELECT COALESCE(sd.d, st.d, sp.d) AS d,
         COALESCE(sd.gross,0) AS gross, COALESCE(sd.net_ex_vat,0) AS net_ex_vat,
         COALESCE(sd.refunds,0) AS refunds, COALESCE(sd.discounts,0) AS discounts,
         COALESCE(sd.orders,0) AS orders, COALESCE(sd.paid_orders,0) AS paid_orders,
         COALESCE(sd.new_customers,0) AS new_customers,
         COALESCE(sd.returning_orders,0) AS returning_orders,
         COALESCE(sd.new_cust_revenue,0) AS new_cust_revenue,
         COALESCE(sd.cogs,0) AS cogs, COALESCE(sd.shipping,0) AS shipping,
         COALESCE(sd.other_fulfil,0) AS other_fulfil, COALESCE(sd.processing,0) AS processing,
         COALESCE(sd.uncosted_units,0) AS uncosted_units,
         COALESCE(sd.uncosted_orders,0) AS uncosted_orders,
         COALESCE(sd.comp_cost,0) AS comp_cost,
         COALESCE(sd.prepaid_cost,0) AS prepaid_cost,
         COALESCE(st.paid,0) AS stripe_paid,
         COALESCE(sp.spend,0) AS ad_spend
    FROM shop_daily sd
    FULL OUTER JOIN stripe_daily st ON st.d = sd.d
    FULL OUTER JOIN spend_daily sp ON sp.d = COALESCE(sd.d, st.d)
   WHERE COALESCE(sd.d, st.d, sp.d) IS NOT NULL
   ORDER BY 1
`;

/**
 * Recompute `daily_metrics` from scratch. Idempotent and safe to re-run — the
 * blended row per day is upserted on (date, channel) with channel NULL, which the
 * NULLS NOT DISTINCT unique index makes a genuine upsert rather than a duplicate.
 */
export async function rebuildDailyMetrics(): Promise<RollupResult> {
  // Per-order costed margin first — the Profit page and International view read it,
  // and rebuilding it here keeps every margin surface consistent with this rollup.
  await rebuildOrderProfit();

  const data = await rows<Record<string, unknown>>(DAILY_SOURCE);

  let channelRows = 0;
  for (const r of data) {
    const date = String(r.d);
    const gross = num(r.gross);
    const netExVat = num(r.net_ex_vat);
    const stripePaid = num(r.stripe_paid);
    const adSpend = num(r.ad_spend);
    const cogs = num(r.cogs);
    const shipping = num(r.shipping);
    const otherFulfil = num(r.other_fulfil);
    const processing = num(r.processing);
    const discounts = num(r.discounts);

    // Revenue for efficiency ratios includes both money sources.
    const totalRevenue = netExVat + stripePaid;
    const newCustRevenue = num(r.new_cust_revenue);
    const newCustomers = num(r.new_customers);
    const paidOrders = num(r.paid_orders);

    const cm = contributionMargin({
      netRevenueCents: totalRevenue,
      cogsCents: cogs,
      fulfillmentCents: shipping + otherFulfil,
      processingCents: processing,
      discountsCents: 0, // already reflected in net revenue
      adSpendCents: adSpend,
    });

    const values = {
      date,
      channel: null as string | null,
      currency: "USD",
      revenueAmount: totalRevenue,
      newCustomerRevenueAmount: newCustRevenue,
      orders: num(r.orders),
      newCustomers,
      returningCustomers: num(r.returning_orders),
      adSpendAmount: adSpend,
      cogsAmount: cogs,
      shippingAmount: shipping,
      processingAmount: processing,
      discountsAmount: discounts,
      refundsAmount: num(r.refunds),
      cm1Amount: cm.cm1Cents,
      cm2Amount: cm.cm2Cents,
      cm3Amount: cm.cm3Cents,
      mer: mer(totalRevenue, adSpend),
      amer: amer(newCustRevenue, adSpend),
      // Channel-level ROAS needs attribution (Phase 7); null beats a guess.
      roas: null as number | null,
      cac: cac(adSpend, newCustomers),
      aov: aov(gross, paidOrders),
      unknownCogsLineCount: num(r.uncosted_units),
      unknownCogsOrderCount: num(r.uncosted_orders),
    };

    await db.execute(sql`
      INSERT INTO daily_metrics (
        date, channel, currency, revenue_amount, new_customer_revenue_amount,
        orders, new_customers, returning_customers, ad_spend_amount, cogs_amount,
        shipping_amount, processing_amount, discounts_amount, refunds_amount,
        cm1_amount, cm2_amount, cm3_amount, mer, amer, roas, cac, aov,
        unknown_cogs_line_count, unknown_cogs_order_count, computed_at
      ) VALUES (
        ${values.date}, ${values.channel}, ${values.currency}, ${values.revenueAmount},
        ${values.newCustomerRevenueAmount}, ${values.orders}, ${values.newCustomers},
        ${values.returningCustomers}, ${values.adSpendAmount}, ${values.cogsAmount},
        ${values.shippingAmount}, ${values.processingAmount}, ${values.discountsAmount},
        ${values.refundsAmount}, ${values.cm1Amount}, ${values.cm2Amount}, ${values.cm3Amount},
        ${values.mer}, ${values.amer}, ${values.roas}, ${values.cac}, ${values.aov},
        ${values.unknownCogsLineCount}, ${values.unknownCogsOrderCount}, now()
      )
      ON CONFLICT (date, channel) DO UPDATE SET
        currency = EXCLUDED.currency,
        revenue_amount = EXCLUDED.revenue_amount,
        new_customer_revenue_amount = EXCLUDED.new_customer_revenue_amount,
        orders = EXCLUDED.orders,
        new_customers = EXCLUDED.new_customers,
        returning_customers = EXCLUDED.returning_customers,
        ad_spend_amount = EXCLUDED.ad_spend_amount,
        cogs_amount = EXCLUDED.cogs_amount,
        shipping_amount = EXCLUDED.shipping_amount,
        processing_amount = EXCLUDED.processing_amount,
        discounts_amount = EXCLUDED.discounts_amount,
        refunds_amount = EXCLUDED.refunds_amount,
        cm1_amount = EXCLUDED.cm1_amount,
        cm2_amount = EXCLUDED.cm2_amount,
        cm3_amount = EXCLUDED.cm3_amount,
        mer = EXCLUDED.mer, amer = EXCLUDED.amer, roas = EXCLUDED.roas,
        cac = EXCLUDED.cac, aov = EXCLUDED.aov,
        unknown_cogs_line_count = EXCLUDED.unknown_cogs_line_count,
        unknown_cogs_order_count = EXCLUDED.unknown_cogs_order_count,
        computed_at = EXCLUDED.computed_at
    `);
    channelRows++;
  }

  // Per-platform ad spend rows so Marketing can break spend down by channel even
  // before attribution exists. Revenue stays null on these to avoid implying
  // attributed revenue we haven't modelled yet.
  const spendByChannel = await rows<Record<string, unknown>>(sql`
    SELECT date AS d, platform::text AS channel, sum(spend_amount) AS spend,
           sum(impressions) AS impressions, sum(clicks) AS clicks
      FROM ad_spend GROUP BY 1, 2 ORDER BY 1, 2
  `);

  for (const r of spendByChannel) {
    await db.execute(sql`
      INSERT INTO daily_metrics (date, channel, currency, ad_spend_amount, computed_at)
      VALUES (${String(r.d)}, ${String(r.channel)}, 'USD', ${num(r.spend)}, now())
      ON CONFLICT (date, channel) DO UPDATE SET
        ad_spend_amount = EXCLUDED.ad_spend_amount,
        computed_at = EXCLUDED.computed_at
    `);
    channelRows++;
  }

  const result: RollupResult = {
    daysComputed: data.length,
    channelRows,
    firstDate: data.length ? String(data[0].d) : null,
    lastDate: data.length ? String(data[data.length - 1].d) : null,
  };
  logger.info("daily_metrics rebuilt", { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Read helpers — the dashboard reads THESE, never the raw tables.
// ---------------------------------------------------------------------------

export interface PeriodMetrics {
  revenueCents: number;
  newCustomerRevenueCents: number;
  adSpendCents: number;
  cogsCents: number;
  cm1Cents: number;
  cm2Cents: number;
  cm3Cents: number;
  orders: number;
  newCustomers: number;
  /** Repeat ORDERS (additive across days), not distinct returning customers. */
  returningOrders: number;
  mer: number | null;
  amer: number | null;
  cac: number | null;
  cm3Pct: number | null;
  unknownCogsUnits: number;
}

/** Aggregate the blended rows over a date range. */
export async function getPeriodMetrics(since: string, until: string): Promise<PeriodMetrics> {
  const [r] = await rows<Record<string, unknown>>(sql`
    SELECT
      COALESCE(sum(revenue_amount),0) AS revenue,
      COALESCE(sum(new_customer_revenue_amount),0) AS new_cust_revenue,
      COALESCE(sum(ad_spend_amount),0) AS ad_spend,
      COALESCE(sum(cogs_amount),0) AS cogs,
      COALESCE(sum(cm1_amount),0) AS cm1,
      COALESCE(sum(cm2_amount),0) AS cm2,
      COALESCE(sum(cm3_amount),0) AS cm3,
      COALESCE(sum(orders),0) AS orders,
      COALESCE(sum(new_customers),0) AS new_customers,
      -- Column holds repeat ORDERS (see the rollup query), which sums correctly.
      COALESCE(sum(returning_customers),0) AS returning_orders,
      COALESCE(sum(unknown_cogs_line_count),0) AS unknown_cogs
    FROM daily_metrics
    WHERE channel IS NULL AND date >= ${since} AND date <= ${until}
  `);

  const revenue = num(r.revenue);
  const adSpend = num(r.ad_spend);
  const newCustRevenue = num(r.new_cust_revenue);
  const newCustomers = num(r.new_customers);

  return {
    revenueCents: revenue,
    newCustomerRevenueCents: newCustRevenue,
    adSpendCents: adSpend,
    cogsCents: num(r.cogs),
    cm1Cents: num(r.cm1),
    cm2Cents: num(r.cm2),
    cm3Cents: num(r.cm3),
    orders: num(r.orders),
    newCustomers,
    returningOrders: num(r.returning_orders),
    mer: mer(revenue, adSpend),
    amer: amer(newCustRevenue, adSpend),
    cac: cac(adSpend, newCustomers),
    cm3Pct: ratio(num(r.cm3), revenue),
    unknownCogsUnits: num(r.unknown_cogs),
  };
}

export interface DailyPoint {
  date: string;
  revenueCents: number;
  adSpendCents: number;
  cm3Cents: number;
  mer: number | null;
  orders: number;
}

export async function getDailySeries(since: string, until: string): Promise<DailyPoint[]> {
  const data = await rows<Record<string, unknown>>(sql`
    SELECT date::text AS date, revenue_amount, ad_spend_amount, cm3_amount, mer, orders
      FROM daily_metrics
     WHERE channel IS NULL AND date >= ${since} AND date <= ${until}
     ORDER BY date
  `);
  return data.map((r) => ({
    date: String(r.date),
    revenueCents: num(r.revenue_amount),
    adSpendCents: num(r.ad_spend_amount),
    cm3Cents: num(r.cm3_amount),
    mer: r.mer == null ? null : Number(r.mer),
    orders: num(r.orders),
  }));
}

/**
 * Rebuild `order_profit` — the single materialised source of per-order costed
 * margin, used by the Profit page, the International view and the daily rollup.
 *
 * The cost logic lives HERE and only here:
 *  - COGS: the product_costs row for (sku, fulfilment origin) with the greatest
 *    effective_date <= the order date; falls back to origin 'default', then a
 *    synthetic `variant:<uuid>` key for SKU-less items.
 *  - Shipping: actual invoice charge > per-label rate rule > zone average, with
 *    `ship_basis` recording which was used.
 *  - Net revenue: (gross − refunds) ÷ (1 + VAT), because international prices are
 *    tax-inclusive.
 *  - Revenue class: paid / prepaid_delivery / comp (never blended — see rollup).
 *
 * Written as one INSERT … SELECT so the whole table is built in a single pass
 * rather than a correlated lookup per page load.
 */
import { sql } from "drizzle-orm";
import { REVENUE_CLASS_CASE } from "./revenue-class";
import { db } from "../db/client";
import { logger } from "../lib/logger";
import { expectedRateCentsSql } from "../lib/shipping/rate-rules";

export interface OrderProfitRebuildResult {
  orders: number;
  ms: number;
}

export async function rebuildOrderProfit(): Promise<OrderProfitRebuildResult> {
  const started = Date.now();

  await db.execute(sql`TRUNCATE TABLE order_profit`);

  await db.execute(sql`
    INSERT INTO order_profit (
      order_id, order_number, processed_on, country, revenue_class, order_type,
      origin, zone, currency, gross_amount, net_ex_vat_amount, refunds_amount,
      discounts_amount, units, cogs_amount, uncosted_units, ship_cost_amount,
      ship_charged_amount, duties_amount, other_fulfil_amount, processing_amount,
      ship_basis, cm1_amount, cm2_amount, computed_at
    )
    WITH ord AS (
      SELECT o.id, o.order_number, o.processed_at::date AS d, o.currency,
             o.discount_codes,
             o.total_amount, o.total_refunded_amount, o.total_discounts_amount,
             o.shipping_amount, o.order_type, o.subscription_meta_id,
             COALESCE(o.shipping_country, o.billing_country) AS country,
             o.fulfillment_origin_override,
             -- Does this customer hold a subscription in either system? Used to tell
             -- a prepaid issue delivery apart from a genuine free copy.
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
             -- Single definition, shared with metrics/rollup.ts. See metrics/revenue-class.ts
             -- for the classes and why the branch order matters.
             ${REVENUE_CLASS_CASE} AS revenue_class
        FROM ord LEFT JOIN market_config mc ON mc.country_code = ord.country
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
             ca.packaging_amount, ca.pick_pack_amount, ca.processing_pct
        FROM ord_mkt om
        LEFT JOIN LATERAL (
          SELECT * FROM cost_assumptions c
           WHERE c.zone = om.zone AND c.effective_date <= om.d
           ORDER BY c.effective_date DESC LIMIT 1
        ) ca ON true
    ),
    actual_ship AS (
      SELECT order_id, sum(ship_amount + surcharge_amount) AS ship_actual,
             sum(duties_amount) AS duties_actual
        FROM shipping_charges WHERE order_id IS NOT NULL GROUP BY order_id
    ),
    rate_est AS (
      SELECT f.order_id,
             sum(${expectedRateCentsSql({
               fulfilment: "f",
               country: sql`om.country`,
               zone: sql`om.zone`,
               effectiveOn: sql`COALESCE(f.shipped_at::date, om.d)`,
             })}) AS ship_rate
        FROM fulfillments f JOIN ord_mkt om ON om.id = f.order_id
       GROUP BY f.order_id
    ),
    calc AS (
      SELECT om.id, om.order_number, om.d, om.country, om.revenue_class,
             om.order_type::text AS order_type, om.origin, om.zone, om.currency,
             om.total_amount AS gross,
             ROUND((om.total_amount - om.total_refunded_amount)
                   / (1 + COALESCE(om.vat_pct, 0)))::bigint AS net_ex_vat,
             om.total_refunded_amount AS refunds,
             om.total_discounts_amount AS discounts,
             COALESCE(lc.units, 0)::int AS units,
             COALESCE(lc.cogs, 0)::bigint AS cogs,
             COALESCE(lc.uncosted_units, 0)::int AS uncosted_units,
             COALESCE(asx.ship_actual, re.ship_rate, zc.ship_cost_amount, 0)::bigint AS ship_cost,
             om.shipping_amount AS ship_charged,
             COALESCE(asx.duties_actual, 0)::bigint AS duties,
             (COALESCE(lc.units, 0) * COALESCE(zc.freight_per_unit_amount, 0)
               + COALESCE(zc.packaging_amount, 0)
               + COALESCE(zc.pick_pack_amount, 0))::bigint AS other_fulfil,
             ROUND(om.total_amount * COALESCE(zc.processing_pct, 0))::bigint AS processing,
             CASE WHEN asx.ship_actual IS NOT NULL THEN 'actual'
                  WHEN re.ship_rate IS NOT NULL THEN 'rate_rule'
                  ELSE 'zone_estimate' END AS ship_basis
        FROM ord_mkt om
        LEFT JOIN line_costs lc ON lc.order_id = om.id
        LEFT JOIN zone_costs zc ON zc.order_id = om.id
        LEFT JOIN actual_ship asx ON asx.order_id = om.id
        LEFT JOIN rate_est re ON re.order_id = om.id
    )
    SELECT id, order_number, d, country, revenue_class, order_type, origin, zone,
           currency, gross, net_ex_vat, refunds, discounts, units, cogs,
           uncosted_units, ship_cost, ship_charged, duties, other_fulfil, processing,
           ship_basis,
           (net_ex_vat - cogs) AS cm1,
           (net_ex_vat - cogs - ship_cost - duties - other_fulfil - processing) AS cm2,
           now()
      FROM calc
  `);

  const [row] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM order_profit`,
  )) as unknown as Array<{ n: number }>;

  const result = { orders: Number(row?.n ?? 0), ms: Date.now() - started };
  logger.info("order_profit rebuilt", { ...result });
  return result;
}

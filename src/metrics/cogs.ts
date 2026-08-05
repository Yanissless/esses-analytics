/**
 * COGS resolution and contribution-margin tiers (Sections 5 & 7).
 *
 * Cost resolution rules, in order:
 *   1. Fulfilment origin comes from the order's destination country via
 *      market_config.fulfillment_origin (US distribution vs the UK printer park),
 *      unless the order carries an explicit fulfillment_origin_override.
 *   2. Unit cost = the product_costs row for (sku, origin) with the greatest
 *      effective_date <= the order's processed_at. Falls back to origin
 *      'default' when no origin-specific cost exists.
 *   3. Line items with no SKU fall back to matching via their variant.
 *
 * Contribution margin tiers:
 *   CM1 = net revenue − COGS
 *   CM2 = CM1 − shipping cost − packaging − pick/pack − processing − returns
 *   CM3 = CM2 − ad spend            (ad spend arrives in Phase 5)
 *
 * Net revenue is ex-VAT: international prices are tax-inclusive, so
 * net = gross / (1 + applicable VAT rate) using the market's VAT basis.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
const num = (v: unknown): number => Number(v ?? 0);

/**
 * Per-order costed view. Implemented as one SQL statement so it stays fast over
 * thousands of orders; every join is a lookup of the cost effective at the time
 * of that order (never today's cost).
 */
const COSTED_ORDERS = sql`
  WITH ord AS (
    SELECT o.id, o.order_number, o.processed_at, o.currency,
           o.total_amount, o.total_refunded_amount, o.total_discounts_amount,
           o.shipping_amount, o.total_tax_amount, o.order_type,
           o.subscription_meta_id,
           COALESCE(o.shipping_country, o.billing_country) AS country,
           o.fulfillment_origin_override
    FROM orders o
    WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
  ),
  ord_mkt AS (
    SELECT ord.*,
           mc.market_name,
           mc.shipping_zone,
           COALESCE(ord.fulfillment_origin_override, mc.fulfillment_origin, 'US') AS origin,
           CASE WHEN mc.vat_basis = 'standard' THEN mc.std_vat_pct
                ELSE COALESCE(mc.print_vat_pct, 0) END AS vat_pct,
           COALESCE(mc.shipping_zone, 'row') AS zone
    FROM ord
    LEFT JOIN market_config mc ON mc.country_code = ord.country
  ),
  -- Unit COGS per order: prefer an origin-specific cost, else 'default'.
  line_costs AS (
    SELECT li.order_id,
           sum(li.quantity) AS units,
           sum(
             li.quantity * COALESCE(
               (SELECT pc.cost_amount FROM product_costs pc
                 WHERE pc.sku = li.sku AND pc.origin = om.origin
                   AND pc.effective_date <= COALESCE(om.processed_at::date, CURRENT_DATE)
                 ORDER BY pc.effective_date DESC LIMIT 1),
               (SELECT pc.cost_amount FROM product_costs pc
                 WHERE pc.sku = li.sku AND pc.origin = 'default'
                   AND pc.effective_date <= COALESCE(om.processed_at::date, CURRENT_DATE)
                 ORDER BY pc.effective_date DESC LIMIT 1),
               -- SKU-less items are costed against a synthetic 'variant:<id>' key
               -- (the same key the cost screen offers for them).
               (SELECT pc.cost_amount FROM product_costs pc
                 WHERE pc.sku = 'variant:' || li.variant_id::text
                   AND pc.origin IN (om.origin, 'default')
                   AND pc.effective_date <= COALESCE(om.processed_at::date, CURRENT_DATE)
                 ORDER BY (pc.origin = om.origin) DESC, pc.effective_date DESC LIMIT 1),
               (SELECT pc.cost_amount FROM product_costs pc
                 WHERE pc.variant_id = li.variant_id
                   AND pc.effective_date <= COALESCE(om.processed_at::date, CURRENT_DATE)
                 ORDER BY pc.effective_date DESC LIMIT 1),
               0
             )
           ) AS cogs,
           -- Units we could not cost at all — drives the coverage warning.
           sum(CASE WHEN NOT EXISTS (
                 SELECT 1 FROM product_costs pc
                  WHERE (pc.sku = li.sku
                         OR pc.sku = 'variant:' || li.variant_id::text
                         OR pc.variant_id = li.variant_id)
                    AND pc.effective_date <= COALESCE(om.processed_at::date, CURRENT_DATE)
               ) THEN li.quantity ELSE 0 END) AS uncosted_units
    FROM order_line_items li
    JOIN ord_mkt om ON om.id = li.order_id
    GROUP BY li.order_id
  ),
  zone_costs AS (
    SELECT om.id AS order_id, ca.*
    FROM ord_mkt om
    LEFT JOIN LATERAL (
      SELECT * FROM cost_assumptions c
       WHERE c.zone = om.zone
         AND c.effective_date <= COALESCE(om.processed_at::date, CURRENT_DATE)
       ORDER BY c.effective_date DESC LIMIT 1
    ) ca ON true
  ),
  -- Actual shipping billed for this order (park batch allocation, EasyShip,
  -- carrier invoice). Duties are broken out because DDP shipments on $0
  -- subscription/comp orders are otherwise invisible cost.
  actual_ship AS (
    SELECT sc.order_id,
           sum(sc.ship_amount + sc.surcharge_amount) AS ship_actual,
           sum(sc.duties_amount)                     AS duties_actual
    FROM shipping_charges sc
    WHERE sc.order_id IS NOT NULL
    GROUP BY sc.order_id
  ),
  -- Rate-rule estimate per order (e.g. USPS Media Mail ~$4.95), used when no
  -- invoice has landed yet. Better than a flat zone average.
  rate_est AS (
    SELECT f.order_id,
           sum((SELECT rr.expected_cost_amount
                  FROM shipping_rate_rules rr
                 WHERE (rr.carrier_pattern IS NULL
                         OR lower(coalesce(f.tracking_company,'')) LIKE '%' || lower(rr.carrier_pattern) || '%')
                   AND (rr.service_pattern IS NULL
                         OR lower(coalesce(f.service_name,'')) LIKE '%' || lower(rr.service_pattern) || '%')
                   AND (rr.country_code IS NULL OR rr.country_code = om2.country)
                   AND (rr.exclude_country_code IS NULL
                         OR rr.exclude_country_code <> COALESCE(om2.country, ''))
                   AND (rr.zone IS NULL OR rr.zone = om2.zone)
                   AND rr.effective_date <= COALESCE(f.shipped_at::date, CURRENT_DATE)
                 ORDER BY rr.priority DESC, rr.effective_date DESC
                 LIMIT 1)) AS ship_rate,
           count(*) AS shipments
    FROM fulfillments f
    JOIN ord_mkt om2 ON om2.id = f.order_id
    GROUP BY f.order_id
  )
  SELECT
    om.id, om.order_number, om.processed_at, om.country, om.market_name,
    om.zone, om.origin, om.order_type, om.vat_pct,
    -- Revenue class, because mixing these three understates margin badly:
    --  paid            — money collected on this order
    --  prepaid_delivery— $0 shipment against a subscription already paid for
    --                    (revenue landed on the earlier order: a timing offset)
    --  comp            — free copy (contributor/VIP/seeding): real cost, no
    --                    revenue ever. Marketing spend, not a pricing failure.
    CASE WHEN om.total_amount > 0 THEN 'paid'
         WHEN om.subscription_meta_id IS NOT NULL OR om.order_type = 'subscription_shopify'
           THEN 'prepaid_delivery'
         ELSE 'comp' END AS revenue_class,
    om.total_amount                                        AS gross,
    om.total_refunded_amount                               AS refunds,
    om.shipping_amount                                     AS shipping_charged,
    -- Net of refunds, then ex-VAT (international prices are tax-inclusive).
    ROUND((om.total_amount - om.total_refunded_amount) / (1 + COALESCE(om.vat_pct, 0)))::bigint AS net_ex_vat,
    COALESCE(lc.units, 0)                                  AS units,
    COALESCE(lc.cogs, 0)                                   AS cogs,
    COALESCE(lc.uncosted_units, 0)                         AS uncosted_units,
    -- Shipping cost priority: actual invoice > per-label rate rule > zone average.
    COALESCE(asx.ship_actual, re.ship_rate, zc.ship_cost_amount, 0) AS ship_cost,
    COALESCE(asx.duties_actual, 0)                         AS duties_cost,
    CASE WHEN asx.ship_actual IS NOT NULL THEN 'actual'
         WHEN re.ship_rate IS NOT NULL     THEN 'rate_rule'
         ELSE 'zone_estimate' END                          AS ship_cost_basis,
    COALESCE(lc.units, 0) * COALESCE(zc.freight_per_unit_amount, 0) AS freight_cost,
    COALESCE(zc.packaging_amount, 0)                       AS packaging_cost,
    COALESCE(zc.pick_pack_amount, 0)                       AS pick_pack_cost,
    ROUND(om.total_amount * COALESCE(zc.processing_pct, 0))::bigint AS processing_cost,
    ROUND(COALESCE(zc.return_rate_pct, 0) * COALESCE(zc.return_cost_amount, 0))::bigint AS return_cost
  FROM ord_mkt om
  LEFT JOIN line_costs lc ON lc.order_id = om.id
  LEFT JOIN zone_costs zc ON zc.order_id = om.id
  LEFT JOIN actual_ship asx ON asx.order_id = om.id
  LEFT JOIN rate_est re ON re.order_id = om.id
`;

export interface MarginSummary {
  /** Trading margin — paid orders + the prepaid deliveries they fund. */
  netExVatCents: number;
  cogsCents: number;
  cm1Cents: number;
  variableCostsCents: number;
  cm2Cents: number;
  cm1Pct: number;
  cm2Pct: number;
  orders: number;
  units: number;
  uncostedUnits: number;
  shipChargedCents: number;
  shipCostCents: number;
  shippingGapCents: number;
  /** Free copies: real cost, no revenue. Reported separately as marketing spend. */
  compUnits: number;
  compCostCents: number;
  compOrders: number;
  /** Trading CM2 minus the comp programme — the all-in bottom line. */
  cm2AfterCompsCents: number;
}

export async function getMarginSummary(): Promise<MarginSummary> {
  const [r] = await rows<Record<string, unknown>>(sql`
    WITH c AS (${COSTED_ORDERS})
    SELECT
      count(*) FILTER (WHERE revenue_class <> 'comp')                      AS orders,
      COALESCE(sum(units)   FILTER (WHERE revenue_class <> 'comp'), 0)     AS units,
      COALESCE(sum(uncosted_units) FILTER (WHERE revenue_class <> 'comp'), 0) AS uncosted_units,
      COALESCE(sum(net_ex_vat), 0)                                         AS net_ex_vat,
      COALESCE(sum(cogs)     FILTER (WHERE revenue_class <> 'comp'), 0)    AS cogs,
      COALESCE(sum(shipping_charged), 0)                                   AS ship_charged,
      COALESCE(sum(ship_cost) FILTER (WHERE revenue_class <> 'comp'), 0)   AS ship_cost,
      COALESCE(sum(freight_cost + packaging_cost + pick_pack_cost + processing_cost + return_cost + duties_cost)
               FILTER (WHERE revenue_class <> 'comp'), 0)                  AS other_var,
      count(*) FILTER (WHERE revenue_class = 'comp')                       AS comp_orders,
      COALESCE(sum(units) FILTER (WHERE revenue_class = 'comp'), 0)        AS comp_units,
      COALESCE(sum(cogs + ship_cost + duties_cost + freight_cost + packaging_cost + pick_pack_cost)
               FILTER (WHERE revenue_class = 'comp'), 0)                   AS comp_cost
    FROM c
  `);

  const net = num(r.net_ex_vat);
  const cogs = num(r.cogs);
  const shipCost = num(r.ship_cost);
  const otherVar = num(r.other_var);
  const cm1 = net - cogs;
  const variable = shipCost + otherVar;
  const cm2 = cm1 - variable;
  const compCost = num(r.comp_cost);

  return {
    netExVatCents: net,
    cogsCents: cogs,
    cm1Cents: cm1,
    variableCostsCents: variable,
    cm2Cents: cm2,
    cm1Pct: net ? cm1 / net : 0,
    cm2Pct: net ? cm2 / net : 0,
    orders: num(r.orders),
    units: num(r.units),
    uncostedUnits: num(r.uncosted_units),
    shipChargedCents: num(r.ship_charged),
    shipCostCents: shipCost,
    shippingGapCents: num(r.ship_charged) - shipCost,
    compUnits: num(r.comp_units),
    compOrders: num(r.comp_orders),
    compCostCents: compCost,
    cm2AfterCompsCents: cm2 - compCost,
  };
}

export interface MarketMargin {
  country: string | null;
  marketName: string | null;
  zone: string | null;
  origin: string | null;
  orders: number;
  units: number;
  grossCents: number;
  netExVatCents: number;
  vatPct: number;
  cogsCents: number;
  shipChargedCents: number;
  shipCostCents: number;
  otherVariableCents: number;
  cm2Cents: number;
  cm2Pct: number;
  uncostedUnits: number;
  compUnits: number;
  compCostCents: number;
}

/** Per-country actuals — the international margin view. */
export async function getMarketMargins(): Promise<MarketMargin[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH c AS (${COSTED_ORDERS})
    -- Comps are excluded from the margin columns and reported in their own
    -- column, so a market isn't judged on copies it was never paid for.
    SELECT country, market_name, zone, origin,
           max(vat_pct) AS vat_pct,
           count(*) FILTER (WHERE revenue_class <> 'comp') AS orders,
           COALESCE(sum(units) FILTER (WHERE revenue_class <> 'comp'),0) AS units,
           COALESCE(sum(gross),0) AS gross,
           COALESCE(sum(net_ex_vat),0) AS net_ex_vat,
           COALESCE(sum(cogs) FILTER (WHERE revenue_class <> 'comp'),0) AS cogs,
           COALESCE(sum(shipping_charged),0) AS ship_charged,
           COALESCE(sum(ship_cost) FILTER (WHERE revenue_class <> 'comp'),0) AS ship_cost,
           COALESCE(sum(freight_cost + packaging_cost + pick_pack_cost + processing_cost + return_cost + duties_cost)
                    FILTER (WHERE revenue_class <> 'comp'),0) AS other_var,
           COALESCE(sum(uncosted_units) FILTER (WHERE revenue_class <> 'comp'),0) AS uncosted_units,
           COALESCE(sum(units) FILTER (WHERE revenue_class = 'comp'),0) AS comp_units,
           COALESCE(sum(cogs + ship_cost + duties_cost + packaging_cost) FILTER (WHERE revenue_class = 'comp'),0) AS comp_cost
    FROM c
    GROUP BY country, market_name, zone, origin
    HAVING sum(gross) > 0 OR sum(units) > 0
    ORDER BY sum(net_ex_vat) DESC
  `);

  return data.map((r) => {
    const net = num(r.net_ex_vat);
    const cm2 = net - num(r.cogs) - num(r.ship_cost) - num(r.other_var);
    return {
      country: (r.country as string) ?? null,
      marketName: (r.market_name as string) ?? null,
      zone: (r.zone as string) ?? null,
      origin: (r.origin as string) ?? null,
      orders: num(r.orders),
      units: num(r.units),
      grossCents: num(r.gross),
      netExVatCents: net,
      vatPct: num(r.vat_pct),
      cogsCents: num(r.cogs),
      shipChargedCents: num(r.ship_charged),
      shipCostCents: num(r.ship_cost),
      otherVariableCents: num(r.other_var),
      cm2Cents: cm2,
      cm2Pct: net ? cm2 / net : 0,
      uncostedUnits: num(r.uncosted_units),
      compUnits: num(r.comp_units),
      compCostCents: num(r.comp_cost),
    };
  });
}

export interface SkuCostRow {
  sku: string | null;
  title: string | null;
  units: number;
  lines: number;
  grossCents: number;
  costUsCents: number | null;
  costUkCents: number | null;
  costDefaultCents: number | null;
}

/**
 * Costable items for the cost-entry screen.
 *
 * Covers BOTH what has sold (order line items) and the full Shopify catalogue —
 * including products with no orders yet, and merch whose variants carry no SKU
 * (those get a synthetic `variant:<id>` key so they're still costable). Ordered by
 * units sold so the highest-impact gaps sit at the top.
 */
export async function getSkuCostRows(): Promise<SkuCostRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH sold AS (
      SELECT
        COALESCE(NULLIF(li.sku, ''), 'variant:' || COALESCE(li.variant_id::text, 'unknown')) AS cost_key,
        max(li.title) AS title,
        sum(li.quantity) AS units,
        count(*) AS lines,
        sum(li.price_amount * li.quantity) AS gross
      FROM order_line_items li
      JOIN orders o ON o.id = li.order_id
      WHERE o.test = false AND o.cancelled_at IS NULL
      GROUP BY 1
    ),
    catalogue AS (
      SELECT
        COALESCE(NULLIF(pv.sku, ''), 'variant:' || pv.id::text) AS cost_key,
        COALESCE(p.title, pv.title) AS title,
        0::bigint AS units, 0::bigint AS lines, 0::bigint AS gross
      FROM product_variants pv
      LEFT JOIN products p ON p.id = pv.product_id
    ),
    merged AS (
      SELECT cost_key, title, units, lines, gross FROM sold
      UNION ALL
      SELECT c.cost_key, c.title, c.units, c.lines, c.gross FROM catalogue c
       WHERE NOT EXISTS (SELECT 1 FROM sold s WHERE s.cost_key = c.cost_key)
    )
    SELECT m.*,
      (SELECT cost_amount FROM product_costs pc WHERE pc.sku = m.cost_key AND pc.origin = 'US'
        ORDER BY effective_date DESC LIMIT 1) AS cost_us,
      (SELECT cost_amount FROM product_costs pc WHERE pc.sku = m.cost_key AND pc.origin = 'UK'
        ORDER BY effective_date DESC LIMIT 1) AS cost_uk,
      (SELECT cost_amount FROM product_costs pc WHERE pc.sku = m.cost_key AND pc.origin = 'default'
        ORDER BY effective_date DESC LIMIT 1) AS cost_default
    FROM merged m
    ORDER BY m.units DESC NULLS LAST, m.title
  `);

  return data.map((r) => ({
    sku: (r.cost_key as string) ?? null,
    title: (r.title as string) ?? null,
    units: num(r.units),
    lines: num(r.lines),
    grossCents: num(r.gross),
    costUsCents: r.cost_us == null ? null : num(r.cost_us),
    costUkCents: r.cost_uk == null ? null : num(r.cost_uk),
    costDefaultCents: r.cost_default == null ? null : num(r.cost_default),
  }));
}

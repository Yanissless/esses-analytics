/**
 * Profit analysis (Section 9.3): CM waterfall, profitability by product, and the
 * drill into which orders actually lose money.
 *
 * Reuses the same cost resolution as metrics/cogs.ts — origin-aware COGS effective
 * at the order date, and shipping preferring the actual invoice over a rate rule
 * over a zone average — so the Profit page can never disagree with the
 * International page about the same order.
 *
 * Comps are held out of margin and reported as their own line: a free copy has real
 * cost and no revenue, so leaving it inside CM would make the trading business look
 * unprofitable when the cost is really a marketing decision.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";
import { DEFAULT_MARGIN_BOUNDARY, type MarginBoundary } from "./margin-boundary";
import { boundaryCostFilter, boundaryCostFilterFor } from "./margin-boundary.server";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
const num = (v: unknown): number => Number(v ?? 0);

/**
 * Reads the materialised `order_profit` table (rebuilt by the metrics job) instead
 * of resolving costs per line item on every page load — that version needed a
 * correlated lookup per line item, four times per page, and timed out. The cost
 * logic itself now lives in exactly one place: metrics/order-profit.ts.
 */
const ORDER_PROFIT = sql`
  SELECT order_id AS id, order_number, processed_on, country, revenue_class,
         order_type, gross_amount AS gross, net_ex_vat_amount AS net_ex_vat,
         units, cogs_amount AS cogs, uncosted_units,
         ship_cost_amount AS ship_cost, ship_charged_amount AS ship_charged,
         duties_amount AS duties_cost, other_fulfil_amount AS other_fulfil,
         processing_amount AS processing, ship_basis, cm2_amount AS cm2
    FROM order_profit
`;

export interface WaterfallStep {
  label: string;
  /** Negative for costs. */
  deltaCents: number;
  /** Running total after this step. */
  runningCents: number;
  /** Share of net revenue. */
  pctOfRevenue: number | null;
  kind: "revenue" | "cost" | "margin";
  note?: string;
}

export interface ProfitWaterfall {
  steps: WaterfallStep[];
  netRevenueCents: number;
  cm1Cents: number;
  cm2Cents: number;
  cm3Cents: number;
  cm3PctOfRevenue: number | null;
  compCostCents: number;
  cm3AfterCompsCents: number;
  adSpendCents: number;
}

export async function getProfitWaterfall(
  since: string,
  until: string,
  boundary: MarginBoundary = DEFAULT_MARGIN_BOUNDARY,
): Promise<ProfitWaterfall> {
  const costFilter = boundaryCostFilter(boundary);
  const [r] = await rows<Record<string, unknown>>(sql`
    WITH p AS (${ORDER_PROFIT})
    SELECT
      -- Revenue is boundary-independent: comps and prepaid deliveries collected $0,
      -- so only the cost aggregates below respond to the setting.
      COALESCE(sum(net_ex_vat), 0) AS net_revenue,
      COALESCE(sum(cogs) FILTER (WHERE ${costFilter}), 0) AS cogs,
      COALESCE(sum(ship_cost) FILTER (WHERE ${costFilter}), 0) AS shipping,
      COALESCE(sum(duties_cost) FILTER (WHERE ${costFilter}), 0) AS duties,
      COALESCE(sum(other_fulfil) FILTER (WHERE ${costFilter}), 0) AS other_fulfil,
      COALESCE(sum(processing) FILTER (WHERE ${costFilter}), 0) AS processing,
      COALESCE(sum(cogs + ship_cost + duties_cost + other_fulfil) FILTER (WHERE revenue_class = 'comp'), 0) AS comp_cost
    FROM p
    WHERE processed_on >= ${since} AND processed_on <= ${until}
  `);

  const [spendRow] = await rows<Record<string, unknown>>(sql`
    SELECT COALESCE(sum(spend_amount), 0) AS spend FROM ad_spend
     WHERE date >= ${since} AND date <= ${until}
  `);

  const netRevenue = num(r.net_revenue);
  const cogs = num(r.cogs);
  const shipping = num(r.shipping);
  const duties = num(r.duties);
  const otherFulfil = num(r.other_fulfil);
  const processing = num(r.processing);
  const adSpend = num(spendRow.spend);
  const compCost = num(r.comp_cost);

  const cm1 = netRevenue - cogs;
  const cm2 = cm1 - shipping - duties - otherFulfil - processing;
  const cm3 = cm2 - adSpend;
  const p = (v: number) => ratio(v, netRevenue);

  const steps: WaterfallStep[] = [
    { label: "Net revenue (ex-VAT)", deltaCents: netRevenue, runningCents: netRevenue, pctOfRevenue: 1, kind: "revenue" },
    { label: "COGS", deltaCents: -cogs, runningCents: cm1, pctOfRevenue: p(-cogs), kind: "cost" },
    { label: "CM1", deltaCents: 0, runningCents: cm1, pctOfRevenue: p(cm1), kind: "margin" },
    { label: "Shipping", deltaCents: -shipping, runningCents: cm1 - shipping, pctOfRevenue: p(-shipping), kind: "cost" },
    {
      label: "Duties (DDP)",
      deltaCents: -duties,
      runningCents: cm1 - shipping - duties,
      pctOfRevenue: p(-duties),
      kind: "cost",
      note: duties === 0 ? "none recorded yet — EasyShip import pending" : undefined,
    },
    { label: "Packaging & freight", deltaCents: -otherFulfil, runningCents: cm1 - shipping - duties - otherFulfil, pctOfRevenue: p(-otherFulfil), kind: "cost" },
    { label: "Payment processing", deltaCents: -processing, runningCents: cm2, pctOfRevenue: p(-processing), kind: "cost" },
    { label: "CM2", deltaCents: 0, runningCents: cm2, pctOfRevenue: p(cm2), kind: "margin" },
    {
      label: "Ad spend",
      deltaCents: -adSpend,
      runningCents: cm3,
      pctOfRevenue: p(-adSpend),
      kind: "cost",
      note: adSpend === 0 ? "no ad spend loaded — CM3 equals CM2 until Meta connects" : undefined,
    },
    { label: "CM3", deltaCents: 0, runningCents: cm3, pctOfRevenue: p(cm3), kind: "margin" },
  ];

  return {
    steps,
    netRevenueCents: netRevenue,
    cm1Cents: cm1,
    cm2Cents: cm2,
    cm3Cents: cm3,
    cm3PctOfRevenue: p(cm3),
    compCostCents: compCost,
    cm3AfterCompsCents: cm3 - compCost,
    adSpendCents: adSpend,
  };
}

export interface ProductProfit {
  sku: string | null;
  title: string | null;
  units: number;
  revenueCents: number;
  cogsCents: number;
  cm1Cents: number;
  cm1Pct: number | null;
  unitRevenueCents: number | null;
  unitCostCents: number | null;
  uncostedUnits: number;
}

/**
 * Profitability by product. CM1 only — shipping and processing are order-level, so
 * splitting them across line items of a mixed order would be an arbitrary
 * allocation dressed up as fact.
 *
 * Reads `revenue_class` and `origin` from `order_profit` rather than re-deriving
 * them. It used to re-derive, and its copy of the CASE was missing the
 * `customer_has_subscription` branch — so ~2,400 units of prepaid subscription
 * delivery were classified as free comps and then excluded, understating units and
 * distorting unit cost for every subscription product. See `REVENUE_CLASS_NOTE`.
 */
export async function getProductProfit(
  since: string,
  until: string,
  boundary: MarginBoundary = DEFAULT_MARGIN_BOUNDARY,
): Promise<ProductProfit[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ord AS (
      SELECT op.order_id AS id, op.processed_on AS processed_at, op.origin,
             op.revenue_class
        FROM order_profit op
       WHERE op.processed_on >= ${since} AND op.processed_on <= ${until}
         AND ${boundaryCostFilterFor("op", boundary)}
    )
    SELECT COALESCE(NULLIF(li.sku, ''), 'variant:' || COALESCE(li.variant_id::text, '?')) AS sku,
           max(li.title) AS title,
           sum(li.quantity) AS units,
           sum((li.price_amount * li.quantity) - li.total_discount_amount) AS revenue,
           sum(li.quantity * COALESCE(
             (SELECT pc.cost_amount FROM product_costs pc
               WHERE pc.sku = li.sku AND pc.origin = ord.origin
                 AND pc.effective_date <= ord.processed_at::date
               ORDER BY pc.effective_date DESC LIMIT 1),
             (SELECT pc.cost_amount FROM product_costs pc
               WHERE pc.sku = li.sku AND pc.origin = 'default'
                 AND pc.effective_date <= ord.processed_at::date
               ORDER BY pc.effective_date DESC LIMIT 1),
             (SELECT pc.cost_amount FROM product_costs pc
               WHERE pc.sku = 'variant:' || li.variant_id::text
                 AND pc.effective_date <= ord.processed_at::date
               ORDER BY pc.effective_date DESC LIMIT 1),
             0)) AS cogs,
           sum(CASE WHEN NOT EXISTS (
                 SELECT 1 FROM product_costs pc
                  WHERE (pc.sku = li.sku
                         OR pc.sku = 'variant:' || li.variant_id::text
                         OR pc.variant_id = li.variant_id)
                    AND pc.effective_date <= ord.processed_at::date
               ) THEN li.quantity ELSE 0 END) AS uncosted_units
      FROM order_line_items li
      JOIN ord ON ord.id = li.order_id
     GROUP BY 1
     ORDER BY sum((li.price_amount * li.quantity) - li.total_discount_amount) DESC
  `);

  return data.map((r) => {
    const revenue = num(r.revenue);
    const cogs = num(r.cogs);
    const units = num(r.units);
    return {
      sku: (r.sku as string) ?? null,
      title: (r.title as string) ?? null,
      units,
      revenueCents: revenue,
      cogsCents: cogs,
      cm1Cents: revenue - cogs,
      cm1Pct: ratio(revenue - cogs, revenue),
      unitRevenueCents: ratio(revenue, units),
      unitCostCents: ratio(cogs, units),
      uncostedUnits: num(r.uncosted_units),
    };
  });
}

export interface OrderProfit {
  orderNumber: string | null;
  processedAt: string | null;
  country: string | null;
  revenueClass: string;
  netRevenueCents: number;
  cogsCents: number;
  shipCostCents: number;
  shipChargedCents: number;
  shipBasis: string;
  cm2Cents: number;
  cm2Pct: number | null;
  units: number;
}

/**
 * Least-profitable paid orders — the "which orders actually lose money" drill.
 * Restricted to `paid` orders because a $0 prepaid delivery is structurally
 * negative (its revenue landed on an earlier order) and would fill the whole list
 * without telling anyone anything.
 */
export async function getWorstOrders(
  since: string,
  until: string,
  limit = 20,
): Promise<OrderProfit[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH p AS (${ORDER_PROFIT})
    SELECT order_number, processed_on::text AS processed_at, country, revenue_class,
           net_ex_vat, cogs, ship_cost, ship_charged, ship_basis, units,
           cm2
      FROM p
     WHERE revenue_class = 'paid'
       AND processed_on >= ${since} AND processed_on <= ${until}
     ORDER BY (net_ex_vat - cogs - ship_cost - duties_cost - other_fulfil - processing) ASC
     LIMIT ${limit}
  `);

  return data.map((r) => {
    const net = num(r.net_ex_vat);
    const cm2 = num(r.cm2);
    return {
      orderNumber: (r.order_number as string) ?? null,
      processedAt: (r.processed_at as string) ?? null,
      country: (r.country as string) ?? null,
      revenueClass: String(r.revenue_class),
      netRevenueCents: net,
      cogsCents: num(r.cogs),
      shipCostCents: num(r.ship_cost),
      shipChargedCents: num(r.ship_charged),
      shipBasis: String(r.ship_basis),
      cm2Cents: cm2,
      cm2Pct: ratio(cm2, net),
      units: num(r.units),
    };
  });
}

export interface ProfitQuality {
  paidOrders: number;
  lossMakingOrders: number;
  lossMakingRevenueCents: number;
  lossMakingCm2Cents: number;
  uncostedUnits: number;
  totalUnits: number;
  shipBasisActual: number;
  shipBasisRate: number;
  shipBasisZone: number;
}

/** How much of the margin picture rests on estimates rather than invoices. */
export async function getProfitQuality(since: string, until: string): Promise<ProfitQuality> {
  const [r] = await rows<Record<string, unknown>>(sql`
    -- cm2 comes straight from the materialised table; recomputing it here would
    -- both duplicate the formula and shadow the column.
    WITH p AS (${ORDER_PROFIT}), q AS (
      SELECT * FROM p WHERE processed_on >= ${since} AND processed_on <= ${until}
    )
    SELECT count(*) FILTER (WHERE revenue_class = 'paid') AS paid_orders,
           count(*) FILTER (WHERE revenue_class = 'paid' AND cm2 < 0) AS loss_orders,
           COALESCE(sum(net_ex_vat) FILTER (WHERE revenue_class = 'paid' AND cm2 < 0), 0) AS loss_revenue,
           COALESCE(sum(cm2) FILTER (WHERE revenue_class = 'paid' AND cm2 < 0), 0) AS loss_cm2,
           COALESCE(sum(uncosted_units), 0) AS uncosted_units,
           COALESCE(sum(units), 0) AS total_units,
           count(*) FILTER (WHERE ship_basis = 'actual') AS basis_actual,
           count(*) FILTER (WHERE ship_basis = 'rate_rule') AS basis_rate,
           count(*) FILTER (WHERE ship_basis = 'zone_estimate') AS basis_zone
      FROM q
  `);

  return {
    paidOrders: num(r.paid_orders),
    lossMakingOrders: num(r.loss_orders),
    lossMakingRevenueCents: num(r.loss_revenue),
    lossMakingCm2Cents: num(r.loss_cm2),
    uncostedUnits: num(r.uncosted_units),
    totalUnits: num(r.total_units),
    shipBasisActual: num(r.basis_actual),
    shipBasisRate: num(r.basis_rate),
    shipBasisZone: num(r.basis_zone),
  };
}

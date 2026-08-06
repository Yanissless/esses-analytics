/**
 * COGS coverage and sensitivity — "what would margin be if a copy cost $X?"
 *
 * Per-unit print cost is the single largest unknown in the model: it's an unverified
 * $11.48 placeholder from one sheet, older calculators said ~$5.50, and at ~11,000
 * units the difference is bigger than the entire contribution margin. Until the real
 * figure arrives there is no point pretending to a precise answer, so this module
 * gives the two things that are actually useful in the meantime:
 *
 *  1. **Coverage** — which products carry a cost at all, and how many units are
 *     exposed by the ones that don't. Turns "update COGS someday" into a short,
 *     ordered list where the top row is worth 790 units and the bottom row is worth 3.
 *  2. **Sensitivity** — margin recomputed at any per-unit cost, plus the breakeven
 *     cost where CM3 reaches zero. That answers "how much can we afford to pay per
 *     copy?", which is a decision Esses can act on before the printer confirms
 *     anything.
 *
 * Scenarios are deliberately **ephemeral**. They never write to `product_costs`;
 * committing a real cost stays a deliberate, effective-dated edit at `/costs`, because
 * a what-if that quietly becomes the recorded truth is how a placeholder turns into a
 * fact nobody remembers deciding.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";
import { DEFAULT_MARGIN_BOUNDARY, type MarginBoundary } from "./margin-boundary";
import { boundaryCostFilter } from "./margin-boundary.server";

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const num = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Pure maths (unit-tested)
// ---------------------------------------------------------------------------

export interface BreakevenInput {
  netRevenueCents: number;
  /** Every non-COGS cost already charged under the active boundary. */
  otherCostsCents: number;
  adSpendCents: number;
  units: number;
}

/**
 * The per-unit COGS at which CM3 reaches exactly zero — the most we can afford to pay
 * per copy before advertising stops being covered.
 *
 * Returns null when there are no units (nothing to divide by), and can legitimately
 * return a NEGATIVE number: that means the other costs alone already exceed revenue,
 * so no print price, however cheap, would make CM3 positive. Reporting that honestly
 * is more useful than clamping it to zero and implying a free print run would work.
 */
export function breakevenCogsPerUnitCents(input: BreakevenInput): number | null {
  if (input.units <= 0) return null;
  const headroom = input.netRevenueCents - input.otherCostsCents - input.adSpendCents;
  return Math.round(headroom / input.units);
}

/** Margin at a hypothetical per-unit cost, given everything else held constant. */
export function marginAtCogs(
  input: BreakevenInput,
  perUnitCents: number,
): { cogsCents: number; cm1Cents: number; cm2Cents: number; cm3Cents: number; cm3Pct: number | null } {
  const cogs = Math.round(perUnitCents * input.units);
  const cm1 = input.netRevenueCents - cogs;
  const cm2 = cm1 - input.otherCostsCents;
  const cm3 = cm2 - input.adSpendCents;
  return {
    cogsCents: cogs,
    cm1Cents: cm1,
    cm2Cents: cm2,
    cm3Cents: cm3,
    cm3Pct: ratio(cm3, input.netRevenueCents),
  };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface CogsCoverageRow {
  /** SKU, or the synthetic `variant:<uuid>` key the cost screen accepts. */
  sku: string;
  title: string | null;
  /** Issue number parsed from the title, when it is an issue at all. */
  issueNumber: number | null;
  units: number;
  costed: boolean;
  /** Current cost per unit, when one is set. */
  costCents: number | null;
  /** Units with no applicable cost record — what setting this row would fix. */
  exposedUnits: number;
}

/**
 * Every product that has actually sold, with whether it carries a cost.
 *
 * Ordered by exposed units, so the list doubles as a work queue: fixing the top row
 * removes more uncertainty than the bottom twenty combined.
 */
export async function getCogsCoverage(limit = 60): Promise<CogsCoverageRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH used AS (
      SELECT COALESCE(NULLIF(li.sku, ''), 'variant:' || li.variant_id::text) AS sku,
             max(li.title) AS title,
             sum(li.quantity)::int AS units,
             -- Units whose cost lookup finds nothing effective at the order date.
             sum(CASE WHEN NOT EXISTS (
                   SELECT 1 FROM product_costs pc
                    WHERE (pc.sku = li.sku
                           OR pc.sku = 'variant:' || li.variant_id::text
                           OR pc.variant_id = li.variant_id)
                      AND pc.effective_date <= op.processed_on
                 ) THEN li.quantity ELSE 0 END)::int AS exposed_units
        FROM order_line_items li
        JOIN order_profit op ON op.order_id = li.order_id
       GROUP BY 1
    )
    SELECT u.sku, u.title, u.units, u.exposed_units,
           (regexp_match(lower(u.title), 'issue\\s*#?\\s*0*([0-9]{1,2})'))[1]::int AS issue_no,
           (SELECT pc.cost_amount FROM product_costs pc
             WHERE pc.sku = u.sku ORDER BY pc.effective_date DESC LIMIT 1) AS cost_amount
      FROM used u
     ORDER BY u.exposed_units DESC, u.units DESC
     LIMIT ${limit}
  `);

  return data.map((r) => ({
    sku: String(r.sku),
    title: r.title == null ? null : String(r.title),
    issueNumber: r.issue_no == null ? null : num(r.issue_no),
    units: num(r.units),
    costed: r.cost_amount != null,
    costCents: r.cost_amount == null ? null : num(r.cost_amount),
    exposedUnits: num(r.exposed_units),
  }));
}

export interface CogsCoverageSummary {
  totalUnits: number;
  costedUnits: number;
  exposedUnits: number;
  coveragePct: number | null;
  distinctProducts: number;
  costedProducts: number;
  /** Distinct per-unit costs currently in force — >1 means COGS already varies. */
  distinctCostValues: number;
}

export async function getCogsCoverageSummary(): Promise<CogsCoverageSummary> {
  const [r] = await rows<Record<string, unknown>>(sql`
    WITH used AS (
      SELECT COALESCE(NULLIF(li.sku, ''), 'variant:' || li.variant_id::text) AS sku,
             sum(li.quantity)::int AS units,
             sum(CASE WHEN NOT EXISTS (
                   SELECT 1 FROM product_costs pc
                    WHERE (pc.sku = li.sku
                           OR pc.sku = 'variant:' || li.variant_id::text
                           OR pc.variant_id = li.variant_id)
                      AND pc.effective_date <= op.processed_on
                 ) THEN li.quantity ELSE 0 END)::int AS exposed
        FROM order_line_items li
        JOIN order_profit op ON op.order_id = li.order_id
       GROUP BY 1
    )
    SELECT sum(units)::int AS total_units,
           sum(exposed)::int AS exposed_units,
           count(*)::int AS products,
           count(*) FILTER (WHERE exposed = 0)::int AS costed_products,
           (SELECT count(DISTINCT cost_amount)::int FROM product_costs) AS distinct_costs
      FROM used
  `);

  const total = num(r?.total_units);
  const exposed = num(r?.exposed_units);
  return {
    totalUnits: total,
    costedUnits: total - exposed,
    exposedUnits: exposed,
    coveragePct: ratio(total - exposed, total),
    distinctProducts: num(r?.products),
    costedProducts: num(r?.costed_products),
    distinctCostValues: num(r?.distinct_costs),
  };
}

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

export interface CogsSensitivity {
  boundary: MarginBoundary;
  /** Units bearing cost under the boundary — the scenario multiplier. */
  units: number;
  netRevenueCents: number;
  /** Non-COGS costs charged under the boundary. */
  otherCostsCents: number;
  adSpendCents: number;
  /** COGS actually recorded today, for comparison against the scenarios. */
  actualCogsCents: number;
  actualPerUnitCents: number | null;
  /** Per-unit COGS at which CM3 hits zero; may be negative (see the helper). */
  breakevenPerUnitCents: number | null;
  scenarios: Array<{
    perUnitCents: number;
    label: string;
    cogsCents: number;
    cm1Cents: number;
    cm2Cents: number;
    cm3Cents: number;
    cm3Pct: number | null;
    isCurrent: boolean;
  }>;
}

/** The per-unit costs worth showing by default, in cents. */
const DEFAULT_SCENARIO_CENTS = [400, 550, 700, 850, 1000, 1148, 1300];

/**
 * Margin across a range of per-unit COGS values, under the active boundary.
 *
 * Scales `units × perUnit` rather than re-running the cost ladder: the question is
 * "what if the print cost were different", and the ladder's origin/effective-date
 * resolution is irrelevant to that. It also keeps the scenario honest about what it
 * changes — only print cost, with shipping, packaging, processing and ad spend all
 * held exactly as recorded.
 */
export async function getCogsSensitivity(
  since: string,
  until: string,
  boundary: MarginBoundary = DEFAULT_MARGIN_BOUNDARY,
  extraScenarioCents: number[] = [],
): Promise<CogsSensitivity> {
  const costFilter = boundaryCostFilter(boundary);

  const [r] = await rows<Record<string, unknown>>(sql`
    SELECT COALESCE(sum(net_ex_vat_amount), 0)::bigint AS net_revenue,
           COALESCE(sum(units) FILTER (WHERE ${costFilter}), 0)::int AS units,
           COALESCE(sum(cogs_amount) FILTER (WHERE ${costFilter}), 0)::bigint AS cogs,
           COALESCE(sum(ship_cost_amount + duties_amount + other_fulfil_amount
                        + processing_amount) FILTER (WHERE ${costFilter}), 0)::bigint AS other_costs
      FROM order_profit
     WHERE processed_on >= ${since} AND processed_on <= ${until}
  `);

  const [spendRow] = await rows<Record<string, unknown>>(sql`
    SELECT COALESCE(sum(spend_amount), 0)::bigint AS spend FROM ad_spend
     WHERE date >= ${since} AND date <= ${until}
  `);

  const input: BreakevenInput = {
    netRevenueCents: num(r?.net_revenue),
    otherCostsCents: num(r?.other_costs),
    adSpendCents: num(spendRow?.spend),
    units: num(r?.units),
  };

  const actualCogs = num(r?.cogs);
  const actualPerUnit = input.units > 0 ? Math.round(actualCogs / input.units) : null;

  const wanted = [...new Set([...DEFAULT_SCENARIO_CENTS, ...extraScenarioCents])].sort(
    (a, b) => a - b,
  );

  return {
    boundary,
    units: input.units,
    netRevenueCents: input.netRevenueCents,
    otherCostsCents: input.otherCostsCents,
    adSpendCents: input.adSpendCents,
    actualCogsCents: actualCogs,
    actualPerUnitCents: actualPerUnit,
    breakevenPerUnitCents: breakevenCogsPerUnitCents(input),
    scenarios: wanted.map((c) => ({
      perUnitCents: c,
      label: `$${(c / 100).toFixed(2)}`,
      ...marginAtCogs(input, c),
      // Within a cent of what's recorded — flags the status-quo row.
      isCurrent: actualPerUnit != null && Math.abs(c - actualPerUnit) <= 1,
    })),
  };
}

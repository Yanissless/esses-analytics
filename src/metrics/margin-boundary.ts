/**
 * The margin boundary — which revenue classes bear cost when margin is computed.
 *
 * ## Why this is a setting and not a decision
 *
 * Prepaid subscription deliveries incur cost in one period while their revenue was
 * recognised in an earlier one, so "what is our margin?" has three defensible
 * answers depending on where the line is drawn. Earlier sessions treated that as an
 * accounting decision waiting on a human, which left `/profit` and `/international`
 * reporting different CM2 for the same period with no way to reconcile them.
 *
 * It's a live, editable setting instead. Revenue is identical under all three options
 * — comps and prepaid deliveries collect $0 by definition — so the boundary only ever
 * changes which COSTS are charged. That makes it safe to flip: a lens, not a
 * restatement, and nothing is rebuilt when it changes.
 *
 * ⚠️ **This module must stay dependency-free.** It's imported by the client-side
 * settings form, so pulling in drizzle or the DB client drags the Postgres driver
 * into the browser bundle and the build fails with `Can't resolve 'fs'`. The SQL
 * predicates and the settings read live in `margin-boundary.server.ts`.
 */

export type MarginBoundary = "paid_only" | "exclude_comps" | "all_classes";

/** Narrowest to widest cost inclusion — the settings form renders in this order. */
export const MARGIN_BOUNDARIES: MarginBoundary[] = [
  "paid_only",
  "exclude_comps",
  "all_classes",
];

export const DEFAULT_MARGIN_BOUNDARY: MarginBoundary = "paid_only";

export interface MarginBoundaryMeta {
  id: MarginBoundary;
  label: string;
  /** One line for a settings form. */
  short: string;
  /** The full trade-off, for help text — each option is defensible, none is "right". */
  explanation: string;
}

export const BOUNDARY_META: Record<MarginBoundary, MarginBoundaryMeta> = {
  paid_only: {
    id: "paid_only",
    label: "Paid orders only",
    short: "Charge only the costs of orders that collected money.",
    explanation:
      "Matches each order's revenue to its own costs, so margin % answers 'how profitable is a sale?'. Understates cash cost, because fulfilling a prepaid subscription delivery is real money going out that this view ignores. The most flattering of the three, and the right one for pricing decisions.",
  },
  exclude_comps: {
    id: "exclude_comps",
    label: "Paid + prepaid deliveries",
    short: "Also charge the cost of shipping issues already paid for.",
    explanation:
      "Adds the cost of fulfilling subscriptions sold in an earlier period, but excludes free copies. Currently negative, because ten months of deliveries are charged against subscription revenue that was recognised up front. Closest to cash reality for the trading business.",
  },
  all_classes: {
    id: "all_classes",
    label: "Everything, including comps",
    short: "Charge every cost, including contributor and VIP copies.",
    explanation:
      "The true all-in bottom line. Treats the comp programme as a cost of doing business rather than as marketing spend, so it answers 'did we make money overall?' — but it will always look worse than trading margin, and comps are a deliberate choice rather than a pricing problem.",
  },
};

export function isMarginBoundary(v: unknown): v is MarginBoundary {
  return typeof v === "string" && (MARGIN_BOUNDARIES as string[]).includes(v);
}

/**
 * ⚠️ `revenue_class` is derived in exactly ONE place: `metrics/order-profit.ts`.
 *
 * It used to be re-derived in four, and two of those copies silently missed the
 * `customer_has_subscription` branch — so `/international` and the per-product table
 * on `/profit` classified prepaid subscription deliveries as free giveaways, inflating
 * comp counts and dropping those units out of trading margin entirely. Every consumer
 * now joins `order_profit` instead of re-deriving.
 *
 * If a new surface needs revenue_class, JOIN order_profit. Do not write another CASE.
 */
export const REVENUE_CLASS_NOTE =
  "revenue_class is derived only in metrics/order-profit.ts; join order_profit to read it";

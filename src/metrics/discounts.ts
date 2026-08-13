/**
 * Discount code review — what each code costs, against what it is worth.
 *
 * ## The comparison this page lives or dies on
 *
 * Every figure here is measured against a **baseline of orders that carried no marketing
 * code**. That baseline is the honest part and also the dangerous part, because coded and
 * uncoded orders are not the same population:
 *
 *  - A welcome code is used almost exclusively by first-time buyers. Comparing its margin to
 *    a baseline full of repeat customers measures "first order vs any order", not "the code's
 *    effect".
 *  - A code attached to a free-issue offer will always look catastrophic, because giving the
 *    issue away is the point. That is the same trap `/creatives` handles by labelling
 *    acquisition plays rather than ranking them on ROAS.
 *
 * So `vsBaseline` is reported as a difference, never as a verdict, and `classify` refuses to
 * call anything a problem on margin alone. `population` states who actually used the code so
 * the reader can see when the comparison is unlike-for-unlike.
 *
 * ## Margin boundary
 *
 * Everything is **CM2** — net ex-VAT, less COGS, less fulfilment. Ad spend is deliberately
 * NOT in it: a code's cost is a product decision, and mixing acquisition spend in would make
 * codes used by paid traffic look worse than identical codes used by organic. The boundary is
 * returned on the summary so the page can name it, per the standing rule that no margin
 * figure is quoted without its boundary.
 *
 * ## Per-order averages divide by PAID orders, and the first version of this got it wrong
 *
 * Dividing by all orders produced a baseline CM2/order of **-$1.31** across 6,284 uncoded
 * orders — i.e. the average order with no discount was reported as loss-making. It isn't. The
 * baseline was full of $0 Shopify orders that carry COGS while their revenue is recognised in
 * Skio, so the denominator counted orders the numerator was never paid for.
 *
 * That is not a small distortion. With a baseline near zero, every comparison against it
 * explodes: real codes came back at -1424%, +3904%, -38253%. Numbers that absurd are at least
 * visible; a baseline that landed at a plausible-but-wrong $4 would have produced a table of
 * plausible-but-wrong verdicts, which is worse.
 *
 * So the comparable average is CM2 over **paid** orders. Total CM2 still counts everything,
 * because the giveaway COGS is real money — the two are reported separately rather than one
 * standing in for the other.
 *
 * ## Operational codes are excluded
 *
 * `isMarketingPromo` drops replacements, comps and customer-service credits. Those are
 * refunds wearing a discount code's clothes; counting them as promotions would make the
 * discount programme look far more expensive than it is, and there is no decision to take
 * about them.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { OPS_DISCOUNT_SQL_REGEX } from "./churn";
import { ratio } from "./formulas";

/** Below this, a code's averages are noise and it is reported but never ranked or judged. */
export const MIN_ORDERS_TO_JUDGE = 20;

/** GP/order this far below baseline is worth a look, as a fraction. */
export const WATCH_THRESHOLD = 0.15;
/** And this far below is worth a decision. */
export const REVIEW_THRESHOLD = 0.3;

/** Share of a code's orders that must be $0 before it is read as an acquisition offer. */
export const FREE_SHARE_THRESHOLD = 0.8;

export type CodeVerdict = "healthy" | "watch" | "review" | "acquisition" | "too-few";

export interface DiscountCodeRow {
  code: string;
  orders: number;
  /** Orders on this code that collected nothing — a giveaway, not a discount. */
  freeOrders: number;
  /** Orders that actually collected money. The denominator for every average here. */
  paidOrders: number;
  freeShare: number | null;
  /** Face value given away. */
  discountCents: number;
  netExVatCents: number;
  /** Contribution margin after COGS and fulfilment. */
  cm2Cents: number;
  /** CM2 over PAID orders. Null when the code has none — a pure giveaway. */
  cm2PerPaidOrder: number | null;
  cm2Margin: number | null;
  /** CM2/order minus the baseline's, in cents. Negative means the code costs you. */
  vsBaselineCents: number | null;
  /** The same as a fraction of baseline. */
  vsBaselineShare: number | null;
  /** Share of this code's orders placed by first-time buyers. */
  firstOrderShare: number | null;
  verdict: CodeVerdict;
  /** One line saying what the verdict is based on. Always populated. */
  note: string;
}

export interface DiscountBaseline {
  orders: number;
  /** Orders that collected money — the denominator, per the paid-orders rule. */
  paidOrders: number;
  cm2PerPaidOrder: number | null;
  cm2Margin: number | null;
  firstOrderShare: number | null;
}

export interface DiscountReview {
  since: string;
  until: string;
  boundary: string;
  baseline: DiscountBaseline;
  codes: DiscountCodeRow[];
  /** Totals across coded orders only. */
  codedOrders: number;
  codedCm2Cents: number;
  discountGivenCents: number;
  needsReview: number;
}

/**
 * Classifies a code.
 *
 * Order matters. Volume is checked first because every other judgement is an average, and an
 * average over six orders is not evidence. Acquisition is checked next because a giveaway
 * looks identical to a catastrophically unprofitable code on every margin measure — and
 * switching off a working acquisition offer for looking unprofitable is the exact mistake
 * this whole module exists to prevent.
 */
export function classify(row: {
  orders: number;
  freeShare: number | null;
  vsBaselineShare: number | null;
}): { verdict: CodeVerdict; note: string } {
  if (row.orders < MIN_ORDERS_TO_JUDGE) {
    return {
      verdict: "too-few",
      note: `${row.orders} order(s) — below ${MIN_ORDERS_TO_JUDGE}, so the averages are noise. Reported, not ranked.`,
    };
  }
  if ((row.freeShare ?? 0) >= FREE_SHARE_THRESHOLD) {
    return {
      verdict: "acquisition",
      note:
        `${Math.round((row.freeShare ?? 0) * 100)}% of these orders collected nothing, so this ` +
        "is a giveaway rather than a discount. Judge it on what those customers do next, not " +
        "on margin here — margin is negative by design.",
    };
  }
  if (row.vsBaselineShare === null) {
    return { verdict: "watch", note: "No baseline to compare against in this range." };
  }
  const pct = Math.round(Math.abs(row.vsBaselineShare) * 100);
  if (row.vsBaselineShare >= 0) {
    return {
      verdict: "healthy",
      note: `CM2/order is ${pct}% above orders with no code.`,
    };
  }
  if (Math.abs(row.vsBaselineShare) >= REVIEW_THRESHOLD) {
    return {
      verdict: "review",
      note: `CM2/order is ${pct}% below baseline — enough to be worth a decision. Check whether these buyers are new before cutting it.`,
    };
  }
  if (Math.abs(row.vsBaselineShare) >= WATCH_THRESHOLD) {
    return {
      verdict: "watch",
      note: `CM2/order is ${pct}% below baseline. Expected for a discount; worth watching if volume grows.`,
    };
  }
  return {
    verdict: "healthy",
    note: `CM2/order is within ${pct}% of orders with no code.`,
  };
}

const VERDICT_RANK: Record<CodeVerdict, number> = {
  review: 0,
  watch: 1,
  acquisition: 2,
  healthy: 3,
  "too-few": 4,
};

/**
 * Per-code performance for a range, plus the uncoded baseline it is measured against.
 *
 * One row per code per order: an order carrying two codes contributes to both. That double-
 * counts its revenue across rows, which is why the summary reports coded orders DISTINCT and
 * the per-code rows are never summed into a total.
 */
export async function getDiscountReview(since: string, until: string): Promise<DiscountReview> {
  const rows = await db.execute<{
    code: string;
    orders: number;
    free_orders: number;
    paid_orders: number;
    discount_cents: string;
    net_cents: string;
    cm2_cents: string;
    cm2_paid_cents: string;
    first_orders: number;
  }>(sql`
    WITH scoped AS (
      SELECT p.order_id, p.net_ex_vat_amount, p.cm2_amount, p.discounts_amount,
             o.discount_codes, o.processed_at,
             -- First order for this customer, by processed_at. Null customer counts as new.
             (o.customer_id IS NULL OR o.processed_at = (
                SELECT min(o2.processed_at) FROM orders o2
                 WHERE o2.customer_id = o.customer_id
                   AND o2.test = false AND o2.cancelled_at IS NULL
             )) AS is_first
        FROM order_profit p
        JOIN orders o ON o.id = p.order_id
       WHERE o.test = false AND o.cancelled_at IS NULL
         AND o.processed_at::date >= ${since}
         AND o.processed_at::date <= ${until}
    ),
    exploded AS (
      SELECT upper(trim(c)) AS code, s.*
        FROM scoped s, unnest(COALESCE(s.discount_codes, ARRAY[]::text[])) AS c
       WHERE trim(c) <> ''
         -- Operational codes are refunds in disguise. Same regex the churn dimension uses.
         AND trim(c) !~* ${OPS_DISCOUNT_SQL_REGEX}
    )
    SELECT code,
           count(*)::int                                          AS orders,
           count(*) FILTER (WHERE net_ex_vat_amount <= 0)::int     AS free_orders,
           count(*) FILTER (WHERE net_ex_vat_amount > 0)::int      AS paid_orders,
           COALESCE(sum(discounts_amount), 0)::bigint              AS discount_cents,
           COALESCE(sum(net_ex_vat_amount), 0)::bigint             AS net_cents,
           COALESCE(sum(cm2_amount), 0)::bigint                    AS cm2_cents,
           -- CM2 over PAID orders only: a $0 order carries COGS with no revenue, so
           -- including it in the average measures giveaway volume, not code performance.
           COALESCE(sum(cm2_amount) FILTER (WHERE net_ex_vat_amount > 0), 0)::bigint
                                                                   AS cm2_paid_cents,
           count(*) FILTER (WHERE is_first)::int                   AS first_orders
      FROM exploded
     GROUP BY code
     ORDER BY count(*) DESC
  `);

  // The baseline: orders in range carrying NO marketing code at all.
  const baseRows = await db.execute<{
    orders: number;
    paid_orders: number;
    net_cents: string;
    cm2_cents: string;
    cm2_paid_cents: string;
    first_orders: number;
  }>(sql`
    SELECT count(*)::int                                       AS orders,
           count(*) FILTER (WHERE p.net_ex_vat_amount > 0)::int AS paid_orders,
           COALESCE(sum(p.net_ex_vat_amount), 0)::bigint        AS net_cents,
           COALESCE(sum(p.cm2_amount), 0)::bigint               AS cm2_cents,
           COALESCE(sum(p.cm2_amount) FILTER (WHERE p.net_ex_vat_amount > 0), 0)::bigint
                                                               AS cm2_paid_cents,
           count(*) FILTER (WHERE o.customer_id IS NULL OR o.processed_at = (
             SELECT min(o2.processed_at) FROM orders o2
              WHERE o2.customer_id = o.customer_id
                AND o2.test = false AND o2.cancelled_at IS NULL
           ))::int                                             AS first_orders
      FROM order_profit p
      JOIN orders o ON o.id = p.order_id
     WHERE o.test = false AND o.cancelled_at IS NULL
       AND o.processed_at::date >= ${since}
       AND o.processed_at::date <= ${until}
       AND NOT EXISTS (
         SELECT 1 FROM unnest(COALESCE(o.discount_codes, ARRAY[]::text[])) AS c
          WHERE trim(c) <> '' AND trim(c) !~* ${OPS_DISCOUNT_SQL_REGEX}
       )
  `);

  const b = [...baseRows][0];
  const baseOrders = Number(b?.orders ?? 0);
  const basePaid = Number(b?.paid_orders ?? 0);
  const baseCm2Paid = Number(b?.cm2_paid_cents ?? 0);
  const baseNet = Number(b?.net_cents ?? 0);
  const baselineCm2PerOrder = basePaid > 0 ? baseCm2Paid / basePaid : null;

  const baseline: DiscountBaseline = {
    orders: baseOrders,
    paidOrders: basePaid,
    cm2PerPaidOrder: baselineCm2PerOrder,
    cm2Margin: ratio(baseCm2Paid, baseNet),
    firstOrderShare: baseOrders > 0 ? Number(b?.first_orders ?? 0) / baseOrders : null,
  };

  const codes: DiscountCodeRow[] = [...rows].map((r) => {
    const orders = Number(r.orders);
    const paid = Number(r.paid_orders);
    const cm2 = Number(r.cm2_cents);
    const cm2Paid = Number(r.cm2_paid_cents);
    const net = Number(r.net_cents);
    const cm2PerPaidOrder = paid > 0 ? cm2Paid / paid : null;
    const freeShare = orders > 0 ? Number(r.free_orders) / orders : null;

    const vsBaselineCents =
      cm2PerPaidOrder === null || baselineCm2PerOrder === null
        ? null
        : cm2PerPaidOrder - baselineCm2PerOrder;
    // Share is against the ABSOLUTE baseline: a negative baseline would otherwise flip the
    // sign and report a worse code as an improvement.
    const vsBaselineShare =
      vsBaselineCents === null || baselineCm2PerOrder === null || baselineCm2PerOrder === 0
        ? null
        : vsBaselineCents / Math.abs(baselineCm2PerOrder);

    const { verdict, note } = classify({ orders, freeShare, vsBaselineShare });

    return {
      code: r.code,
      orders,
      freeOrders: Number(r.free_orders),
      paidOrders: paid,
      freeShare,
      discountCents: Number(r.discount_cents),
      netExVatCents: net,
      cm2Cents: cm2,
      cm2PerPaidOrder,
      cm2Margin: ratio(cm2Paid, net),
      vsBaselineCents,
      vsBaselineShare,
      firstOrderShare: orders > 0 ? Number(r.first_orders) / orders : null,
      verdict,
      note,
    };
  });

  // Worst first — the point of the page is what needs attention, not what is biggest.
  codes.sort(
    (a, b2) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b2.verdict] || b2.orders - a.orders,
  );

  return {
    since,
    until,
    boundary: "CM2 — net ex-VAT less COGS and fulfilment. Ad spend excluded.",
    baseline,
    codes,
    codedOrders: codes.reduce((s, c) => s + c.orders, 0),
    codedCm2Cents: codes.reduce((s, c) => s + c.cm2Cents, 0),
    discountGivenCents: codes.reduce((s, c) => s + c.discountCents, 0),
    needsReview: codes.filter((c) => c.verdict === "review" || c.verdict === "watch").length,
  };
}

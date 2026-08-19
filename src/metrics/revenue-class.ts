/**
 * The revenue_class CASE — defined exactly once.
 *
 * ## Why this file exists
 *
 * CLAUDE.md rule 1 says there is a single `revenue_class` CASE. There were two: one in
 * `metrics/order-profit.ts` and a copy in `metrics/rollup.ts`, the second carrying the comment
 * *"Must match metrics/order-profit.ts exactly."* A comment is not a mechanism. That is the same
 * copy-paste-then-drift pattern the rule was written about, sitting in the very expression the
 * rule names — and it survived because both copies were correct, so nothing ever failed.
 *
 * Both call sites now import this fragment. They cannot drift.
 *
 * ## The classes
 *
 * - **`paid`** — money was collected on this order.
 * - **`acquisition_gift`** — a free first issue given to win a NEW subscriber. Nobody paid, so
 *   the product and postage are an acquisition cost, the same category as ad spend. Sam's
 *   decision, 18 Aug 2026.
 * - **`comp`** — given away with no expectation of revenue: VIP and client copies, contributor
 *   copies, and win-back offers to lapsed subscribers. Win-back sits here rather than with
 *   acquisition because the recipient had already been won once, so the free period is a
 *   retention expense.
 * - **`prepaid_delivery`** — a $0 order for a customer who already paid. The annual plan bills
 *   $100 once and then delivers quarterly against it, so three of those four deliveries collect
 *   nothing while being fully paid for.
 *
 * ## Order of the branches is load-bearing
 *
 * A free-issue order is also `order_type = 'subscription_shopify'` and belongs to a customer
 * who holds a subscription, so it satisfies the `prepaid_delivery` conditions too. The promo
 * checks therefore come FIRST. Reverse them and every giveaway silently becomes a prepaid
 * delivery again — which is exactly the state this change is correcting, where $34,679 of
 * acquisition cost sat in a bucket meaning "already paid for".
 *
 * ## Why promo codes and not a heuristic
 *
 * The obvious rule, "a $0 order from a customer who never paid before", matches 4,473 orders
 * when only 1,907 are giveaways. It sweeps in ordinary quarterly fulfilments, because for those
 * the money arrives on the subscription charge rather than the delivery order, so the delivery
 * looks unpaid in isolation. Nothing in the order data separates the two — see
 * `metrics/acquisition-promos.ts`.
 *
 * ## Requirement on the caller
 *
 * The CTE this is used against must expose `total_amount`, `subscription_meta_id`, `order_type`,
 * `customer_has_subscription` and `discount_codes`, aliased as `ord`.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  ACQUISITION_PROMO_SQL_REGEX,
  COMP_PROMO_SQL_REGEX,
} from "./acquisition-promos";

/** Every value the CASE can produce. */
export const REVENUE_CLASSES = [
  "paid",
  "acquisition_gift",
  "comp",
  "prepaid_delivery",
] as const;

export type RevenueClass = (typeof REVENUE_CLASSES)[number];

/** True when a class represents a deliberate giveaway rather than a paid or prepaid order. */
export function isGiveaway(cls: string): boolean {
  return cls === "acquisition_gift" || cls === "comp";
}

/** Matches any of the given codes on the `ord.discount_codes` array, case-insensitively. */
function hasCode(regex: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM unnest(COALESCE(ord.discount_codes, ARRAY[]::text[])) AS dc
     WHERE upper(trim(dc)) ~* ${regex}
  )`;
}

/**
 * The single definition. Emit as a column with `AS revenue_class`.
 *
 * Usage:
 *   sql`SELECT ord.*, ${REVENUE_CLASS_CASE} AS revenue_class FROM ord ...`
 */
export const REVENUE_CLASS_CASE: SQL = sql`
  CASE
    WHEN ord.total_amount > 0 THEN 'paid'
    -- Deliberate giveaways first: they also satisfy the prepaid conditions below.
    WHEN ${hasCode(ACQUISITION_PROMO_SQL_REGEX)} THEN 'acquisition_gift'
    WHEN ${hasCode(COMP_PROMO_SQL_REGEX)} THEN 'comp'
    -- A $0 order for someone who already paid: an issue drawn down against a prepaid
    -- subscription, arriving as its own fulfilment order with no selling plan on the line.
    -- Treating these as comps once inflated "free copies" by ~2,400 units and produced a
    -- nonsense negative bottom line.
    WHEN ord.subscription_meta_id IS NOT NULL
         OR ord.order_type = 'subscription_shopify' THEN 'prepaid_delivery'
    WHEN ord.customer_has_subscription THEN 'prepaid_delivery'
    -- Everything left is a copy given to someone who never subscribed and never paid.
    ELSE 'comp'
  END
`;

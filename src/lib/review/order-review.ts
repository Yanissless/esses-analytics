/**
 * Order review queue (Sam's request).
 *
 * Orders where no payment was collected through Shopify are flagged
 * `needs_review` and excluded from revenue until a human confirms. This module
 * surfaces them WITH customer context (name, email, order history, whether
 * they're a subscriber) so it's easy to tell a comp — watch party, member gift,
 * press copy — from a genuine sale that should count.
 *
 * `review_override` ('include' | 'exclude') is set by a reviewer, persists across
 * syncs, and wins over the automatic classification in the metrics layer.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { orders } from "../../db/schema";

export type ReviewDecision = "include" | "exclude";

export interface ReviewOrder {
  orderId: string;
  orderNumber: string | null;
  processedAt: Date | null;
  totalAmount: number;
  currency: string;
  reviewReason: string | null;
  financialStatus: string | null;
  sourceName: string | null;
  tags: string[];
  items: string | null;
  // Customer context — the part that makes a comp obvious.
  customerName: string | null;
  customerEmail: string | null;
  customerOrderCount: number;
  customerPaidTotal: number;
  isSubscriber: boolean;
}

/** Pending review queue, richest (largest value) first. */
export async function listOrdersForReview(limit = 100): Promise<ReviewOrder[]> {
  const rows = await db.execute(sql`
    SELECT
      o.id                                             AS order_id,
      o.order_number,
      o.processed_at,
      o.total_amount,
      o.currency,
      o.review_reason,
      o.financial_status,
      o.source_name,
      COALESCE(c.name,  NULL)                          AS customer_name,
      COALESCE(c.email, NULL)                          AS customer_email,
      (SELECT count(*) FROM orders o2
         WHERE o2.customer_id = o.customer_id
           AND o2.test = false AND o2.cancelled_at IS NULL) AS customer_order_count,
      (SELECT COALESCE(sum(o3.amount_received_amount), 0) FROM orders o3
         WHERE o3.customer_id = o.customer_id)         AS customer_paid_total,
      EXISTS (SELECT 1 FROM subscription_meta sm
                WHERE sm.customer_id = o.customer_id)  AS is_subscriber,
      (SELECT string_agg(li.title || ' x' || li.quantity, '; ')
         FROM order_line_items li WHERE li.order_id = o.id) AS items
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.needs_review = true AND o.review_override IS NULL
    ORDER BY o.total_amount DESC
    LIMIT ${limit}
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    orderId: String(r.order_id),
    orderNumber: (r.order_number as string) ?? null,
    processedAt: r.processed_at ? new Date(r.processed_at as string) : null,
    totalAmount: Number(r.total_amount ?? 0),
    currency: (r.currency as string) ?? "USD",
    reviewReason: (r.review_reason as string) ?? null,
    financialStatus: (r.financial_status as string) ?? null,
    sourceName: (r.source_name as string) ?? null,
    tags: [],
    items: (r.items as string) ?? null,
    customerName: (r.customer_name as string) ?? null,
    customerEmail: (r.customer_email as string) ?? null,
    customerOrderCount: Number(r.customer_order_count ?? 0),
    customerPaidTotal: Number(r.customer_paid_total ?? 0),
    isSubscriber: Boolean(r.is_subscriber),
  }));
}

/**
 * Record a reviewer's decision. `include` makes the order count as revenue;
 * `exclude` confirms it as a comp. Either way it leaves the pending queue and
 * the decision survives future syncs.
 */
export async function setReviewDecision(
  orderId: string,
  decision: ReviewDecision,
): Promise<void> {
  await db
    .update(orders)
    .set({
      reviewOverride: decision,
      countsAsRevenue: decision === "include",
      needsReview: false,
    })
    .where(eq(orders.id, orderId));
}

/** Count still awaiting a decision — for a dashboard badge. */
export async function pendingReviewCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.needsReview, true), isNull(orders.reviewOverride)));
  return row?.n ?? 0;
}

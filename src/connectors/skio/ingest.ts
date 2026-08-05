/**
 * Skio → subscription_meta mapping and upsert (Section 3: ENRICHMENT ONLY).
 *
 * Skio is NOT a source of order revenue — Shopify Orders already carry the money
 * for every subscription renewal. This connector only records plan / status /
 * churn / MRR that Shopify doesn't expose, and links Shopify subscription orders
 * to their Skio subscription. It never inserts or mutates order revenue, so it
 * cannot double-count.
 *
 * Schema verified against the live Skio API (2026-07-28) — see queries.ts.
 *
 * `mapSkioSubscription` is pure (no DB, no order/revenue fields — enrichment by
 * construction) and unit-tested.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { orderLineItems, orders, subscriptionMeta } from "../../db/schema";
import { resolveCustomer } from "../customers";

type SubStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "paused"
  | "canceled"
  | "expired"
  | "unpaid";

interface Policy {
  interval?: string | null;
  intervalCount?: number | null;
}

export interface SkioSubscriptionRaw {
  id?: string;
  platformId?: string | null;
  status?: string | null;
  createdAt?: string | null;
  cancelledAt?: string | null;
  nextBillingDate?: string | null;
  currencyCode?: string | null;
  cyclesCompleted?: number | null;
  BillingPolicy?: Policy | null;
  DeliveryPolicy?: Policy | null;
  StorefrontUser?: {
    id?: string | null;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null;
  Orders?: Array<{ platformId?: string | null }> | null;
  SubscriptionLines?: Array<{
    sellingPlanId?: string | null;
    priceWithoutDiscount?: number | string | null;
    quantity?: number | null;
    OriginalSellingPlan?: { name?: string | null; platformId?: string | null } | null;
    ProductVariant?: { platformId?: string | null } | null;
  }> | null;
}

export interface MappedSkioSubscription {
  customer: {
    email: string | null;
    name: string | null;
    skioStorefrontUserId: string | null;
  };
  meta: {
    skioSubscriptionId: string;
    sellingPlanId: string | null;
    sellingPlanName: string | null;
    status: SubStatus | null;
    rawStatus: string | null;
    startedAt: Date | null;
    nextBillingAt: Date | null;
    cancelledAt: Date | null;
    billingInterval: string | null;
    billingIntervalCount: number | null;
    currency: string;
    mrrAmount: number;
  };
  /** Numeric Shopify order ids this subscription produced (for direct linking). */
  shopifyOrderIds: string[];
}

const asDate = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);

/** Skio prices are decimal major units (e.g. 25 => $25.00). */
function toCents(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Approximate months in one interval period. */
function monthsPerPeriod(interval: string | null | undefined, count: number): number {
  switch ((interval ?? "").toUpperCase()) {
    case "DAY":
      return count / 30;
    case "WEEK":
      return (count * 7) / 30;
    case "MONTH":
      return count;
    case "YEAR":
      return count * 12;
    default:
      return count || 1;
  }
}

/**
 * Monthly recurring revenue for one line, in cents.
 *
 * Skio prices are per DELIVERY, so MRR is driven by the DELIVERY cadence, not the
 * billing cadence. Example (verified live): "Annual Payment, Quarterly Delivery"
 * bills MONTH×12 at $25 per quarterly delivery → 4 deliveries/yr × $25 = $100/yr
 * → $8.33/mo. Falls back to the billing policy when no delivery policy exists.
 */
export function lineMrrCents(
  priceCents: number,
  quantity: number,
  delivery: Policy | null | undefined,
  billing: Policy | null | undefined,
): number {
  const policy = delivery?.interval ? delivery : billing;
  const months = monthsPerPeriod(policy?.interval, policy?.intervalCount ?? 1);
  if (!months || months <= 0) return priceCents * (quantity || 1);
  return Math.round((priceCents * (quantity || 1)) / months);
}

function mapStatus(raw: string | null | undefined): SubStatus | null {
  switch ((raw ?? "").toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "PAUSED":
      return "paused";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "EXPIRED":
      return "expired";
    case "PAST_DUE":
      return "past_due";
    case "UNPAID":
      return "unpaid";
    case "TRIALING":
      return "trialing";
    default:
      return null;
  }
}

/** "gid://shopify/Order/123" -> "123" */
function gidTail(gid: string | null | undefined): string | null {
  if (!gid) return null;
  const tail = gid.split("/").pop();
  return tail && /^\d+$/.test(tail) ? tail : null;
}

export function mapSkioSubscription(raw: SkioSubscriptionRaw): MappedSkioSubscription {
  const lines = raw.SubscriptionLines ?? [];
  const primary = lines[0];

  const mrr = lines.reduce(
    (sum, l) =>
      sum +
      lineMrrCents(
        toCents(l.priceWithoutDiscount),
        l.quantity ?? 1,
        raw.DeliveryPolicy,
        raw.BillingPolicy,
      ),
    0,
  );

  const name = [raw.StorefrontUser?.firstName, raw.StorefrontUser?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    customer: {
      email: raw.StorefrontUser?.email ?? null,
      name: name || null,
      skioStorefrontUserId: raw.StorefrontUser?.id ?? null,
    },
    meta: {
      skioSubscriptionId: raw.id as string,
      // Store the SHOPIFY selling-plan GID (Skio's own id is an internal UUID).
      sellingPlanId: primary?.OriginalSellingPlan?.platformId ?? null,
      sellingPlanName: primary?.OriginalSellingPlan?.name ?? null,
      status: mapStatus(raw.status),
      rawStatus: raw.status ?? null,
      startedAt: asDate(raw.createdAt),
      nextBillingAt: asDate(raw.nextBillingDate),
      cancelledAt: asDate(raw.cancelledAt),
      billingInterval: raw.BillingPolicy?.interval?.toLowerCase() ?? null,
      billingIntervalCount: raw.BillingPolicy?.intervalCount ?? null,
      currency: (raw.currencyCode ?? "USD").toUpperCase(),
      mrrAmount: mrr,
    },
    shopifyOrderIds: (raw.Orders ?? [])
      .map((o) => gidTail(o.platformId))
      .filter((x): x is string => Boolean(x)),
  };
}

export async function ingestSkioSubscription(raw: SkioSubscriptionRaw): Promise<void> {
  const mapped = mapSkioSubscription(raw);

  const customerId = await resolveCustomer({
    email: mapped.customer.email,
    name: mapped.customer.name,
    skioStorefrontUserId: mapped.customer.skioStorefrontUserId,
  });

  const values = { customerId, ...mapped.meta };
  const [row] = await db
    .insert(subscriptionMeta)
    .values(values)
    .onConflictDoUpdate({
      target: subscriptionMeta.skioSubscriptionId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: subscriptionMeta.id });

  // Stamp the subscription onto its Shopify orders.
  //
  // Skio's Subscription.Orders relation and Order.subscriptionId are both empty
  // on this account (verified live), so we link by (customer + selling plan):
  // the Shopify order line carries the selling-plan GID, and subscription_meta
  // stores that same GID. Prefer Skio's own order ids when present.
  //
  // This only writes subscription_meta_id — never a revenue column.
  if (mapped.shopifyOrderIds.length) {
    await db
      .update(orders)
      .set({ subscriptionMetaId: row.id })
      .where(inArray(orders.shopifyOrderId, mapped.shopifyOrderIds));
  } else if (customerId && mapped.meta.sellingPlanId) {
    const planOrderIds = db
      .select({ id: orderLineItems.orderId })
      .from(orderLineItems)
      .where(eq(orderLineItems.sellingPlanId, mapped.meta.sellingPlanId));

    await db
      .update(orders)
      .set({ subscriptionMetaId: row.id })
      .where(and(eq(orders.customerId, customerId), inArray(orders.id, planOrderIds)));
  }
}

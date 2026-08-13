/**
 * Shopify → schema mapping and idempotent upserts.
 *
 * Shopify Orders are the single source of truth for order revenue (Section 3):
 * subscription (Skio) orders arrive here as normal orders carrying a line-item
 * `sellingPlan`, which is how we tag `order_type = subscription_shopify`. We do
 * NOT also count subscription revenue from Skio — that would double-count.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  customers,
  fulfillments,
  orderLineItems,
  orders,
  products,
  productVariants,
  refunds,
} from "../../db/schema";
import { resolveCustomer } from "../customers";
import { classifyOrder } from "./revenue-rules";
import {
  mapJourneyToTouchpoints,
  mapOrderAttributesToTouchpoint,
  type OrderAttribute,
  saveTouchpoints,
  type JourneySummary,
} from "../../attribution/ingest";

// ---- helpers ---------------------------------------------------------------

/** "gid://shopify/Order/123" -> "123". */
export function gidToId(gid: string): string {
  return gid.split("/").pop() as string;
}

/** Decimal money string -> integer minor units (cents). */
export function toCents(amount: string | null | undefined): number {
  if (!amount) return 0;
  return Math.round(parseFloat(amount) * 100);
}

interface MoneySet {
  shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
}
function moneyOf(set: MoneySet | null | undefined): { cents: number; currency: string } {
  return {
    cents: toCents(set?.shopMoney?.amount),
    currency: set?.shopMoney?.currencyCode ?? "USD",
  };
}

// Cache of Shopify variant GID -> our variant uuid, filled on demand.
const variantCache = new Map<string, string>();

async function variantUuid(shopifyVariantGid: string | null | undefined): Promise<string | null> {
  if (!shopifyVariantGid) return null;
  const id = gidToId(shopifyVariantGid);
  const cached = variantCache.get(id);
  if (cached) return cached;
  const [row] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.shopifyVariantId, id))
    .limit(1);
  if (row) variantCache.set(id, row.id);
  return row?.id ?? null;
}

// ---- products --------------------------------------------------------------

export interface ProductNode {
  id: string;
  title?: string | null;
  handle?: string | null;
  productType?: string | null;
  vendor?: string | null;
  status?: string | null;
  variants: { edges: Array<{ node: { id: string; sku?: string | null; title?: string | null; price?: string | null } }> };
}

export async function upsertProduct(node: ProductNode): Promise<number> {
  const shopifyProductId = gidToId(node.id);
  const [product] = await db
    .insert(products)
    .values({
      shopifyProductId,
      title: node.title ?? null,
      handle: node.handle ?? null,
      productType: node.productType ?? null,
      vendor: node.vendor ?? null,
      status: node.status ?? null,
    })
    .onConflictDoUpdate({
      target: products.shopifyProductId,
      set: {
        title: node.title ?? null,
        handle: node.handle ?? null,
        productType: node.productType ?? null,
        vendor: node.vendor ?? null,
        status: node.status ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: products.id });

  let count = 1;
  for (const { node: v } of node.variants.edges) {
    const variantId = gidToId(v.id);
    await db
      .insert(productVariants)
      .values({
        productId: product.id,
        shopifyVariantId: variantId,
        sku: v.sku ?? null,
        title: v.title ?? null,
        priceAmount: toCents(v.price),
        currency: "USD",
      })
      .onConflictDoUpdate({
        target: productVariants.shopifyVariantId,
        set: {
          productId: product.id,
          sku: v.sku ?? null,
          title: v.title ?? null,
          priceAmount: toCents(v.price),
          updatedAt: new Date(),
        },
      });
    variantCache.set(variantId, ""); // invalidate; re-resolved on next lookup
    variantCache.delete(variantId);
    count++;
  }
  return count;
}

// ---- orders ----------------------------------------------------------------

export interface OrderNode {
  id: string;
  name?: string | null;
  processedAt?: string | null;
  createdAt?: string | null;
  cancelledAt?: string | null;
  test?: boolean;
  tags?: string[];
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  sourceName?: string | null;
  app?: { name?: string | null } | null;
  paymentGatewayNames?: string[];
  currencyCode?: string | null;
  presentmentCurrencyCode?: string | null;
  shippingAddress?: { countryCodeV2?: string | null } | null;
  billingAddress?: { countryCodeV2?: string | null } | null;
  discountCodes?: string[] | null;
  subtotalPriceSet?: MoneySet;
  totalPriceSet?: MoneySet & {
    presentmentMoney?: { amount?: string | null; currencyCode?: string | null } | null;
  };
  totalReceivedSet?: MoneySet;
  totalDiscountsSet?: MoneySet;
  totalShippingPriceSet?: MoneySet;
  totalTaxSet?: MoneySet;
  totalRefundedSet?: MoneySet;
  customer?: {
    id: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
  } | null;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        sku?: string | null;
        title?: string | null;
        variantTitle?: string | null;
        quantity: number;
        originalUnitPriceSet?: MoneySet;
        discountedUnitPriceSet?: MoneySet;
        sellingPlan?: { name?: string | null; sellingPlanId?: string | null } | null;
        variant?: { id: string; sku?: string | null } | null;
      };
    }>;
  };
  refunds: Array<{ id: string; createdAt?: string | null; totalRefundedSet?: MoneySet }>;
  /**
   * Shopify's own pre-purchase journey. Present only when the query asks for it
   * (and the app has the customer-data access it requires); absent is fine —
   * attribution simply has nothing to record for that order.
   */
  customAttributes?: OrderAttribute[] | null;
  customerJourneySummary?: JourneySummary | null;
  /** Present when the export includes fulfilments (bulk JSONL nests them). */
  fulfillments?: Array<{
    id: string;
    name?: string | null;
    createdAt?: string | null;
    deliveredAt?: string | null;
    status?: string | null;
    totalQuantity?: number | null;
    service?: { serviceName?: string | null; type?: string | null } | null;
    location?: { name?: string | null } | null;
    trackingInfo?: Array<{
      company?: string | null;
      number?: string | null;
      url?: string | null;
    }> | null;
  }> | null;
}

const asDate = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);

export async function ingestOrder(node: OrderNode): Promise<void> {
  // Resolve/unify the customer.
  let customerId: string | null = null;
  if (node.customer) {
    const name = [node.customer.firstName, node.customer.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    customerId = await resolveCustomer({
      email: node.customer.email,
      name: name || null,
      phone: node.customer.phone,
      shopifyCustomerId: gidToId(node.customer.id),
    });
  }

  const total = moneyOf(node.totalPriceSet);
  const received = moneyOf(node.totalReceivedSet);

  // Classify for revenue recognition (Section 3): Skio vs Stripe/Craft
  // fulfillment (non-revenue) vs one-time.
  const classification = classifyOrder({
    tags: node.tags ?? [],
    appName: node.app?.name ?? null,
    paymentGatewayNames: node.paymentGatewayNames ?? [],
    totalCents: total.cents,
    receivedCents: received.cents,
    lineItems: node.lineItems.edges.map((e) => ({
      title: e.node.title ?? null,
      sellingPlanId: e.node.sellingPlan?.sellingPlanId ?? null,
    })),
  });
  const orderValues = {
    shopifyOrderId: gidToId(node.id),
    customerId,
    orderType: classification.orderType,
    countsAsRevenue: classification.countsAsRevenue,
    revenueExternalSource: classification.revenueExternalSource,
    needsReview: classification.needsReview,
    reviewReason: classification.reviewReason,
    orderNumber: node.name ?? null,
    processedAt: asDate(node.processedAt),
    shopifyCreatedAt: asDate(node.createdAt),
    cancelledAt: asDate(node.cancelledAt),
    currency: total.currency,
    subtotalAmount: moneyOf(node.subtotalPriceSet).cents,
    totalDiscountsAmount: moneyOf(node.totalDiscountsSet).cents,
    shippingAmount: moneyOf(node.totalShippingPriceSet).cents,
    totalTaxAmount: moneyOf(node.totalTaxSet).cents,
    totalAmount: total.cents,
    amountReceivedAmount: received.cents,
    totalRefundedAmount: moneyOf(node.totalRefundedSet).cents,
    financialStatus: node.displayFinancialStatus ?? null,
    fulfillmentStatus: node.displayFulfillmentStatus ?? null,
    sourceName: node.sourceName ?? null,
    test: node.test ?? false,
    // International: destination drives VAT, shipping zone, and fulfilment origin.
    shippingCountry: node.shippingAddress?.countryCodeV2 ?? null,
    billingCountry: node.billingAddress?.countryCodeV2 ?? null,
    // Empty array rather than null when Shopify returns none, so "synced and had
    // no code" is distinguishable from "never synced".
    discountCodes: node.discountCodes ?? [],
    presentmentCurrency:
      node.totalPriceSet?.presentmentMoney?.currencyCode ??
      node.presentmentCurrencyCode ??
      null,
    presentmentTotalAmount: toCents(node.totalPriceSet?.presentmentMoney?.amount),
  };

  const [order] = await db
    .insert(orders)
    .values(orderValues)
    .onConflictDoUpdate({
      target: orders.shopifyOrderId,
      set: { ...orderValues, updatedAt: new Date() },
    })
    .returning({ id: orders.id });

  // Line items.
  for (const { node: li } of node.lineItems.edges) {
    const original = moneyOf(li.originalUnitPriceSet);
    const discounted = moneyOf(li.discountedUnitPriceSet);
    const lineDiscount = Math.max(
      (original.cents - discounted.cents) * (li.quantity ?? 1),
      0,
    );
    const liValues = {
      orderId: order.id,
      shopifyLineItemId: gidToId(li.id),
      variantId: await variantUuid(li.variant?.id),
      sku: li.sku ?? li.variant?.sku ?? null,
      title: li.title ?? null,
      variantTitle: li.variantTitle ?? null,
      quantity: li.quantity ?? 1,
      currency: original.currency,
      priceAmount: original.cents,
      totalDiscountAmount: lineDiscount,
      sellingPlanId: li.sellingPlan?.sellingPlanId ?? null,
      isSubscription: Boolean(li.sellingPlan?.sellingPlanId),
    };
    await db
      .insert(orderLineItems)
      .values(liValues)
      .onConflictDoUpdate({
        target: orderLineItems.shopifyLineItemId,
        set: { ...liValues, updatedAt: new Date() },
      });
  }

  // Attribution touchpoints from Shopify's own customer journey. Only replaces
  // rows when a journey is actually present, so an export without the field never
  // wipes previously-ingested touchpoints.
  if (node.customerJourneySummary || node.customAttributes?.length) {
    const processedAt = asDate(node.processedAt) ?? new Date();
    const touchpoints = mapJourneyToTouchpoints(node.customerJourneySummary, {
      customerId,
      orderId: order.id,
      fallbackAt: processedAt,
    });

    // Attribution the storefront attached to the cart. Appended rather than merged into
    // the journey rows: it answers a question the journey cannot (WHICH ad), so keeping it
    // as its own touchpoint leaves the journey's account of the visit intact and lets the
    // two be compared instead of one silently overwriting the other.
    const fromAttributes = mapOrderAttributesToTouchpoint(node.customAttributes, {
      customerId,
      orderId: order.id,
      occurredAt: processedAt,
    });
    if (fromAttributes) touchpoints.push(fromAttributes);

    await saveTouchpoints(order.id, touchpoints);
  }

  // Fulfilments — the matching keys (tracking number, carrier, location) that let
  // park/EasyShip invoice lines attach real shipping cost to this order.
  for (const f of node.fulfillments ?? []) {
    const tracking = f.trackingInfo?.[0];
    const fValues = {
      orderId: order.id,
      shopifyFulfillmentId: gidToId(f.id),
      name: f.name ?? null,
      trackingCompany: tracking?.company ?? null,
      trackingNumber: tracking?.number ?? null,
      trackingUrl: tracking?.url ?? null,
      locationName: f.location?.name ?? null,
      serviceName: f.service?.serviceName ?? null,
      serviceType: f.service?.type ?? null,
      status: f.status ?? null,
      totalQuantity: f.totalQuantity ?? null,
      shippedAt: asDate(f.createdAt),
      deliveredAt: asDate(f.deliveredAt),
    };
    await db
      .insert(fulfillments)
      .values(fValues)
      .onConflictDoUpdate({
        target: fulfillments.shopifyFulfillmentId,
        set: { ...fValues, updatedAt: new Date() },
      });
  }

  // Refunds.
  for (const r of node.refunds ?? []) {
    const amount = moneyOf(r.totalRefundedSet);
    const rValues = {
      orderId: order.id,
      shopifyRefundId: gidToId(r.id),
      refundedAt: asDate(r.createdAt),
      currency: amount.currency,
      amount: amount.cents,
    };
    await db
      .insert(refunds)
      .values(rValues)
      .onConflictDoUpdate({
        target: refunds.shopifyRefundId,
        set: { ...rValues, updatedAt: new Date() },
      });
  }
}

/**
 * After a backfill, mark each customer's earliest valid order as the acquisition
 * order and stamp customers.first_order_at / acquired_at. Set-based and
 * idempotent — recomputes from scratch each run. Excludes test and cancelled
 * orders. (acquired_at defaults to first-order date; the attribution engine in a
 * later phase may refine it to the acquiring touchpoint.)
 */
export async function finalizeAcquisition(): Promise<void> {
  // Reset, then flag the earliest valid order per customer as acquisition.
  await db.execute(sql`UPDATE orders SET acquisition_order = false WHERE acquisition_order = true`);
  await db.execute(sql`
    UPDATE orders o SET acquisition_order = true
    FROM (
      SELECT DISTINCT ON (customer_id) id
      FROM orders
      WHERE test = false AND cancelled_at IS NULL AND customer_id IS NOT NULL
      ORDER BY customer_id, processed_at ASC NULLS LAST
    ) f
    WHERE o.id = f.id
  `);

  // Stamp first_order_at / acquired_at from each customer's earliest valid order.
  await db.execute(sql`
    UPDATE customers c
    SET first_order_at = t.first_at, acquired_at = t.first_at
    FROM (
      SELECT customer_id, min(processed_at) AS first_at
      FROM orders
      WHERE test = false AND cancelled_at IS NULL AND customer_id IS NOT NULL
      GROUP BY customer_id
    ) t
    WHERE c.id = t.customer_id
  `);
}

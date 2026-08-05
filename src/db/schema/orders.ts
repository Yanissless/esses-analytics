import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, money, pk, timestamps } from "./_shared";
import { orderType } from "./enums";
import { customers } from "./customers";
import { productVariants } from "./catalog";

/**
 * Orders — the single source of truth for ALL order-level revenue, one-time and
 * Skio-subscription alike (Section 3). Skio renewals arrive here as normal
 * Shopify orders; do NOT also count them from Skio. Dedup on `shopify_order_id`.
 *
 * Every money field shares this row's `currency`. Amounts are cents.
 */
export const orders = pgTable(
  "orders",
  {
    id: pk(),
    shopifyOrderId: text("shopify_order_id").notNull(),
    customerId: uuid("customer_id").references(() => customers.id),

    orderType: orderType("order_type").notNull().default("one_time"),
    // True for the customer's first-ever order — the acquisition event.
    acquisitionOrder: boolean("acquisition_order").notNull().default(false),
    // Link to the Skio subscription that generated this order (nullable).
    subscriptionMetaId: uuid("subscription_meta_id"),

    // Revenue recognition (see order_type notes). Stripe/Craft fulfillment
    // orders show a nominal price but received $0 in Shopify — excluded from
    // Shopify revenue so we don't double-count against the Stripe invoice.
    countsAsRevenue: boolean("counts_as_revenue").notNull().default(true),
    revenueExternalSource: text("revenue_external_source"), // e.g. 'stripe', 'prepaid'
    amountReceivedAmount: money("amount_received_amount").notNull().default(0),

    // Manual-review workflow. Orders where no payment was collected (likely comps
    // — watch parties, member gifts) are flagged needs_review and excluded from
    // revenue until a human resolves them. `review_override` ('include'|'exclude')
    // is set only by a reviewer, preserved across syncs, and wins over
    // counts_as_revenue in the metrics.
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),
    reviewOverride: text("review_override"), // null | 'include' | 'exclude'

    orderNumber: text("order_number"), // Shopify name, e.g. "#1001"
    processedAt: timestamp("processed_at", { withTimezone: true }), // reporting date
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    currency: currency().notNull().default("USD"),
    subtotalAmount: money("subtotal_amount").notNull().default(0),
    totalDiscountsAmount: money("total_discounts_amount").notNull().default(0),
    /**
     * Discount codes applied, as Shopify reports them. Needed to answer whether a
     * promo attracts subscribers who then churn faster — the amount alone can't.
     *
     * ⚠️ Two traps when using this. (1) The set mixes marketing promos
     * (`FREEFIRSTISSUE`) with operational adjustments (`Delivery Issue`, `Custom
     * discount`) — filter with `isMarketingPromo()`. (2) Codes appear on prepaid
     * subscription DELIVERIES too, not just the order that acquired the customer,
     * so promo cohorting must read the ACQUISITION order only.
     */
    discountCodes: text("discount_codes").array(),
    shippingAmount: money("shipping_amount").notNull().default(0),
    totalTaxAmount: money("total_tax_amount").notNull().default(0),
    totalAmount: money("total_amount").notNull().default(0), // gross total
    totalRefundedAmount: money("total_refunded_amount").notNull().default(0),

    financialStatus: text("financial_status"),
    fulfillmentStatus: text("fulfillment_status"),
    sourceName: text("source_name"), // web, pos, subscription_contract, etc.
    test: boolean("test").notNull().default(false), // Shopify test orders → exclude

    // International margin analysis. `shipping_country` drives VAT, shipping-zone
    // cost, and the destination→fulfilment-origin routing rule (market_config).
    // Presentment money is what the customer actually saw/paid in their currency.
    shippingCountry: text("shipping_country"), // ISO-3166 alpha-2
    billingCountry: text("billing_country"),
    presentmentCurrency: currency("presentment_currency"),
    presentmentTotalAmount: money("presentment_total_amount"),
    /** Set only to override the routing rule for a specific order. */
    fulfillmentOriginOverride: text("fulfillment_origin_override"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("orders_shopify_id_unique").on(t.shopifyOrderId),
    index("orders_customer_idx").on(t.customerId),
    index("orders_processed_at_idx").on(t.processedAt),
    index("orders_type_idx").on(t.orderType),
    index("orders_subscription_meta_idx").on(t.subscriptionMetaId),
    index("orders_shipping_country_idx").on(t.shippingCountry),
    index("orders_needs_review_idx").on(t.needsReview),
  ],
);

export const orderLineItems = pgTable(
  "order_line_items",
  {
    id: pk(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifyLineItemId: text("shopify_line_item_id"),
    variantId: uuid("variant_id").references(() => productVariants.id),
    sku: text("sku"), // denormalised so COGS matches even if variant unresolved

    title: text("title"),
    variantTitle: text("variant_title"),
    quantity: integer("quantity").notNull().default(1),

    currency: currency().notNull().default("USD"),
    priceAmount: money("price_amount").notNull().default(0), // per unit
    totalDiscountAmount: money("total_discount_amount").notNull().default(0),

    // Subscription tagging at line level (Shopify selling plan allocation).
    sellingPlanId: text("selling_plan_id"),
    isSubscription: boolean("is_subscription").notNull().default(false),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("line_items_shopify_id_unique").on(t.shopifyLineItemId),
    index("line_items_order_idx").on(t.orderId),
    index("line_items_sku_idx").on(t.sku),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: pk(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifyRefundId: text("shopify_refund_id"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    currency: currency().notNull().default("USD"),
    amount: money("amount").notNull().default(0),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("refunds_shopify_id_unique").on(t.shopifyRefundId),
    index("refunds_order_idx").on(t.orderId),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderLineItem = typeof orderLineItems.$inferSelect;
export type Refund = typeof refunds.$inferSelect;

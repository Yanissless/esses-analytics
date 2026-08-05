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
import { subscriptionLine, subStatus } from "./enums";
import { customers } from "./customers";

/**
 * Skio subscription metadata (Section 3). PURELY an enrichment layer over
 * Shopify orders — it carries plan / status / churn / MRR that Shopify itself
 * doesn't expose. It is NOT a second source of order revenue. Orders link back
 * via `orders.subscription_meta_id`.
 */
export const subscriptionMeta = pgTable(
  "subscription_meta",
  {
    id: pk(),
    customerId: uuid("customer_id").references(() => customers.id),
    skioSubscriptionId: text("skio_subscription_id"),

    sellingPlanId: text("selling_plan_id"),
    sellingPlanName: text("selling_plan_name"),
    status: subStatus("status"),
    rawStatus: text("raw_status"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    nextBillingAt: timestamp("next_billing_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }), // churn date

    billingInterval: text("billing_interval"), // day | week | month | year
    billingIntervalCount: integer("billing_interval_count"),
    currency: currency().notNull().default("USD"),
    mrrAmount: money("mrr_amount").notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("submeta_skio_id_unique").on(t.skioSubscriptionId),
    index("submeta_customer_idx").on(t.customerId),
    index("submeta_status_idx").on(t.status),
  ],
);

/**
 * Stripe subscriptions — additive, separate revenue stream (Section 3). Both
 * print and digital bill through the same Stripe account; `subscription_line`
 * splits them. Linked to customers by email match.
 */
export const stripeSubscriptions = pgTable(
  "stripe_subscriptions",
  {
    id: pk(),
    customerId: uuid("customer_id").references(() => customers.id),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),

    subscriptionLine: subscriptionLine("subscription_line").notNull(),
    status: subStatus("status"),
    rawStatus: text("raw_status"),

    productId: text("product_id"),
    priceId: text("price_id"),
    planNickname: text("plan_nickname"),

    interval: text("interval"), // month | year
    intervalCount: integer("interval_count"),
    quantity: integer("quantity").notNull().default(1),

    currency: currency().notNull().default("USD"),
    mrrAmount: money("mrr_amount").notNull().default(0),

    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }), // churn date
    endedAt: timestamp("ended_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("stripe_sub_id_unique").on(t.stripeSubscriptionId),
    index("stripe_sub_customer_idx").on(t.customerId),
    index("stripe_sub_line_idx").on(t.subscriptionLine),
    index("stripe_sub_status_idx").on(t.status),
  ],
);

/** Stripe invoices — the realised revenue events for LTV math. */
export const stripeInvoices = pgTable(
  "stripe_invoices",
  {
    id: pk(),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    customerId: uuid("customer_id").references(() => customers.id),
    subscriptionLine: subscriptionLine("subscription_line"), // denormalised

    status: text("status"), // paid | open | void | uncollectible | draft
    paid: boolean("paid").notNull().default(false),

    currency: currency().notNull().default("USD"),
    subtotalAmount: money("subtotal_amount").notNull().default(0),
    taxAmount: money("tax_amount").notNull().default(0),
    totalAmount: money("total_amount").notNull().default(0),
    amountDueAmount: money("amount_due_amount").notNull().default(0),
    amountPaidAmount: money("amount_paid_amount").notNull().default(0),

    invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("stripe_invoice_id_unique").on(t.stripeInvoiceId),
    index("stripe_invoice_customer_idx").on(t.customerId),
    index("stripe_invoice_sub_idx").on(t.stripeSubscriptionId),
    index("stripe_invoice_invoiced_at_idx").on(t.invoicedAt),
    index("stripe_invoice_line_idx").on(t.subscriptionLine),
  ],
);

export const stripeInvoiceLineItems = pgTable(
  "stripe_invoice_line_items",
  {
    id: pk(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => stripeInvoices.id, { onDelete: "cascade" }),
    stripeLineId: text("stripe_line_id"),
    priceId: text("price_id"),
    productId: text("product_id"),
    subscriptionLine: subscriptionLine("subscription_line"),

    description: text("description"),
    quantity: integer("quantity").notNull().default(1),
    currency: currency().notNull().default("USD"),
    amount: money("amount").notNull().default(0),

    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("stripe_invoice_line_id_unique").on(t.stripeLineId),
    index("stripe_invoice_line_invoice_idx").on(t.invoiceId),
  ],
);

export type SubscriptionMeta = typeof subscriptionMeta.$inferSelect;
export type StripeSubscription = typeof stripeSubscriptions.$inferSelect;
export type StripeInvoice = typeof stripeInvoices.$inferSelect;
export type StripeInvoiceLineItem = typeof stripeInvoiceLineItems.$inferSelect;

/**
 * Stripe → schema mapping and idempotent upserts.
 *
 * Stripe is a fully separate, additive revenue stream (Section 3): print +
 * digital subscriptions billed through one account, split by `subscription_line`.
 * This is where the REAL money lives for the Shopify "fulfillment" orders that
 * were excluded from Shopify revenue. Amounts from Stripe are already in minor
 * units (cents) — no conversion. Linked to unified customers by email.
 */
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  stripeInvoiceLineItems,
  stripeInvoices,
  stripeSubscriptions,
} from "../../db/schema";
import { resolveCustomer } from "../customers";
import { resolveSubscriptionLine, type SubscriptionLine } from "./line-mapping";
import { toMonthlyCents } from "./mrr";

type SubStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "paused"
  | "canceled"
  | "expired"
  | "unpaid";

const asDate = (unixSec: number | null | undefined): Date | null =>
  unixSec ? new Date(unixSec * 1000) : null;

function mapStatus(raw: string | null | undefined): SubStatus | null {
  switch (raw) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "incomplete":
      return "past_due";
    case "unpaid":
      return "unpaid";
    case "paused":
      return "paused";
    case "canceled":
      return "canceled";
    case "incomplete_expired":
      return "expired";
    default:
      return null;
  }
}

function customerFrom(obj: unknown): {
  id: string | null;
  email: string | null;
  name: string | null;
  phone: string | null;
} {
  // `customer` is a string id unless expanded to an object.
  if (obj && typeof obj === "object") {
    const c = obj as Stripe.Customer;
    return {
      id: c.id ?? null,
      email: c.email ?? null,
      name: c.name ?? null,
      phone: c.phone ?? null,
    };
  }
  return { id: typeof obj === "string" ? obj : null, email: null, name: null, phone: null };
}

// ---- subscriptions ---------------------------------------------------------

export async function ingestSubscription(sub: Stripe.Subscription): Promise<void> {
  const s = sub as unknown as Record<string, unknown>; // variant fields by API version
  const cust = customerFrom(sub.customer);
  const customerId = await resolveCustomer({
    email: cust.email,
    name: cust.name,
    phone: cust.phone,
    stripeCustomerId: cust.id,
  });

  const items = sub.items?.data ?? [];
  const primary = items[0];
  const price = primary?.price;
  const productId = typeof price?.product === "string" ? price.product : (price?.product as Stripe.Product | undefined)?.id ?? null;

  const line: SubscriptionLine = resolveSubscriptionLine({
    priceId: price?.id ?? null,
    productId,
    text: price?.nickname ?? null,
  });

  const mrr = items.reduce((sum, it) => {
    const p = it.price;
    return (
      sum +
      toMonthlyCents(
        p?.unit_amount ?? 0,
        it.quantity ?? 1,
        p?.recurring?.interval,
        p?.recurring?.interval_count,
      )
    );
  }, 0);

  const currentPeriodStart =
    (s.current_period_start as number | undefined) ??
    (primary as unknown as { current_period_start?: number })?.current_period_start;
  const currentPeriodEnd =
    (s.current_period_end as number | undefined) ??
    (primary as unknown as { current_period_end?: number })?.current_period_end;

  const values = {
    customerId,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: cust.id,
    subscriptionLine: line,
    status: mapStatus(sub.status),
    rawStatus: sub.status ?? null,
    productId,
    priceId: price?.id ?? null,
    planNickname: price?.nickname ?? null,
    interval: price?.recurring?.interval ?? null,
    intervalCount: price?.recurring?.interval_count ?? null,
    quantity: primary?.quantity ?? 1,
    currency: (sub.currency ?? "usd").toUpperCase(),
    mrrAmount: mrr,
    currentPeriodStart: asDate(currentPeriodStart),
    currentPeriodEnd: asDate(currentPeriodEnd),
    startedAt: asDate(sub.start_date),
    canceledAt: asDate(sub.canceled_at),
    endedAt: asDate(sub.ended_at),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  };

  await db
    .insert(stripeSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: stripeSubscriptions.stripeSubscriptionId,
      set: { ...values, updatedAt: new Date() },
    });
}

// ---- invoices --------------------------------------------------------------

export async function ingestInvoice(inv: Stripe.Invoice): Promise<void> {
  const i = inv as unknown as Record<string, unknown>;
  const cust = customerFrom(inv.customer);
  const customerId = await resolveCustomer({
    email: cust.email ?? inv.customer_email ?? null,
    name: cust.name ?? inv.customer_name ?? null,
    stripeCustomerId: cust.id,
  });

  const lines = inv.lines?.data ?? [];
  // Invoice-level line = the line class of its first item.
  const firstLine = lines[0];
  const firstPrice = (firstLine as unknown as { price?: Stripe.Price })?.price;
  const invoiceLine: SubscriptionLine | null = firstLine
    ? resolveSubscriptionLine({
        priceId: firstPrice?.id ?? null,
        productId: typeof firstPrice?.product === "string" ? firstPrice.product : null,
        text: firstPrice?.nickname ?? firstLine.description ?? null,
      })
    : null;

  const subscriptionId =
    typeof i.subscription === "string"
      ? (i.subscription as string)
      : ((i.subscription as { id?: string } | undefined)?.id ?? null);

  const invoiceValues = {
    stripeInvoiceId: inv.id as string,
    stripeSubscriptionId: subscriptionId,
    customerId,
    subscriptionLine: invoiceLine,
    status: inv.status ?? null,
    paid: (i.paid as boolean | undefined) ?? inv.status === "paid",
    currency: (inv.currency ?? "usd").toUpperCase(),
    subtotalAmount: inv.subtotal ?? 0,
    taxAmount: (i.tax as number | undefined) ?? 0,
    totalAmount: inv.total ?? 0,
    amountDueAmount: inv.amount_due ?? 0,
    amountPaidAmount: inv.amount_paid ?? 0,
    invoicedAt: asDate(inv.created),
    periodStart: asDate((firstLine?.period?.start as number | undefined) ?? null),
    periodEnd: asDate((firstLine?.period?.end as number | undefined) ?? null),
  };

  const [row] = await db
    .insert(stripeInvoices)
    .values(invoiceValues)
    .onConflictDoUpdate({
      target: stripeInvoices.stripeInvoiceId,
      set: { ...invoiceValues, updatedAt: new Date() },
    })
    .returning({ id: stripeInvoices.id });

  for (const li of lines) {
    const price = (li as unknown as { price?: Stripe.Price }).price;
    const productId = typeof price?.product === "string" ? price.product : null;
    const liLine = resolveSubscriptionLine({
      priceId: price?.id ?? null,
      productId,
      text: price?.nickname ?? li.description ?? null,
    });
    const liValues = {
      invoiceId: row.id,
      stripeLineId: li.id as string,
      priceId: price?.id ?? null,
      productId,
      subscriptionLine: liLine,
      description: li.description ?? null,
      quantity: li.quantity ?? 1,
      currency: (li.currency ?? inv.currency ?? "usd").toUpperCase(),
      amount: li.amount ?? 0,
      periodStart: asDate((li.period?.start as number | undefined) ?? null),
      periodEnd: asDate((li.period?.end as number | undefined) ?? null),
    };
    await db
      .insert(stripeInvoiceLineItems)
      .values(liValues)
      .onConflictDoUpdate({
        target: stripeInvoiceLineItems.stripeLineId,
        set: { ...liValues, updatedAt: new Date() },
      });
  }
}

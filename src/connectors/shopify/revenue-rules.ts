/**
 * Order revenue classification (Section 3 dedup — the correctness-critical bit).
 *
 * Some Shopify orders are NOT real Shopify revenue: they're fulfillment proxies
 * for print subscriptions billed through Stripe/Craft. They show a nominal price
 * (e.g. a $35 "Issue 06") but $0 was actually received in Shopify — the real
 * money is the Stripe invoice. Counting them would double-count against Stripe.
 *
 * Two observed flavors in the Esses store:
 *   1. Craft/Stripe subscription orders — tag "Craft Subscription", app
 *      "Esses Craft Orders", empty payment gateway, price $35 / received $0.
 *   2. Dedicated fulfillment products — line titled "... Subscription
 *      Fulfillment" (incl. international "Prepaid"), usually $0.
 *
 * Markers live in FULFILLMENT_MARKERS so they can be extended without code
 * changes as new apps/tags appear. `classifyOrder` is pure and unit-tested.
 */

export type OrderTypeValue =
  | "one_time"
  | "subscription_shopify"
  | "subscription_stripe_fulfillment";

export interface OrderClassificationInput {
  tags: string[];
  appName: string | null;
  paymentGatewayNames: string[];
  totalCents: number;
  receivedCents: number;
  lineItems: Array<{ title: string | null; sellingPlanId: string | null }>;
}

export interface OrderClassification {
  orderType: OrderTypeValue;
  countsAsRevenue: boolean;
  revenueExternalSource: string | null;
  needsReview: boolean;
  reviewReason: string | null;
}

export const FULFILLMENT_MARKERS = {
  /** Order tags (compared case-insensitively) that mean "external-billed fulfillment". */
  tags: ["craft subscription"],
  /** Shopify app names that create fulfillment-only orders. */
  appNames: ["esses craft orders"],
  /** Line-item titles that indicate a fulfillment product. */
  titlePattern: /subscription fulfillment/i,
};

export function classifyOrder(input: OrderClassificationInput): OrderClassification {
  const tagSet = new Set(input.tags.map((t) => t.trim().toLowerCase()));
  const appName = input.appName?.trim().toLowerCase() ?? "";

  const isCraft =
    FULFILLMENT_MARKERS.tags.some((t) => tagSet.has(t)) ||
    FULFILLMENT_MARKERS.appNames.includes(appName);

  const fulfillmentLine = input.lineItems.find((li) =>
    FULFILLMENT_MARKERS.titlePattern.test(li.title ?? ""),
  );

  // Explicit Stripe/Craft fulfillment markers → definitively not Shopify revenue.
  if (isCraft || fulfillmentLine) {
    const source = isCraft
      ? "stripe"
      : /prepaid/i.test(fulfillmentLine?.title ?? "")
        ? "prepaid"
        : "fulfillment";
    return {
      orderType: "subscription_stripe_fulfillment",
      countsAsRevenue: false,
      revenueExternalSource: source,
      needsReview: false,
      reviewReason: null,
    };
  }

  const orderType: OrderTypeValue = input.lineItems.some((li) => li.sellingPlanId)
    ? "subscription_shopify"
    : "one_time";

  // No payment collected through Shopify (nothing received, no gateway) but the
  // order has value → likely a comp (watch party, member gift). Flag for review
  // and exclude from revenue until a human confirms; a genuine exception can be
  // flipped to include via review_override.
  const noPaymentCollected =
    input.receivedCents === 0 &&
    input.totalCents > 0 &&
    input.paymentGatewayNames.length === 0;
  if (noPaymentCollected) {
    return {
      orderType,
      countsAsRevenue: false,
      revenueExternalSource: null,
      needsReview: true,
      reviewReason: "no_payment_collected",
    };
  }

  return {
    orderType,
    countsAsRevenue: true,
    revenueExternalSource: null,
    needsReview: false,
    reviewReason: null,
  };
}

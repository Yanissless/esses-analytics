import { describe, expect, it } from "vitest";
import {
  classifyOrder,
  type OrderClassificationInput,
} from "../src/connectors/shopify/revenue-rules";

function base(overrides: Partial<OrderClassificationInput> = {}): OrderClassificationInput {
  return {
    tags: [],
    appName: null,
    paymentGatewayNames: ["shopify_payments"],
    totalCents: 3000,
    receivedCents: 3000,
    lineItems: [{ title: "Esses Issue 05", sellingPlanId: null }],
    ...overrides,
  };
}

describe("classifyOrder — Section 3 revenue dedup", () => {
  it("flags a Craft/Stripe subscription order (tag) as non-revenue fulfillment", () => {
    const c = classifyOrder(
      base({
        tags: ["Craft Subscription"],
        appName: "Esses Craft Orders",
        paymentGatewayNames: [],
        totalCents: 3500,
        receivedCents: 0,
        lineItems: [{ title: "Esses Issue 06", sellingPlanId: null }],
      }),
    );
    expect(c.orderType).toBe("subscription_stripe_fulfillment");
    expect(c.countsAsRevenue).toBe(false);
    expect(c.revenueExternalSource).toBe("stripe");
  });

  it("flags the Esses Craft Orders app even without the tag", () => {
    const c = classifyOrder(base({ appName: "Esses Craft Orders", tags: [] }));
    expect(c.countsAsRevenue).toBe(false);
    expect(c.orderType).toBe("subscription_stripe_fulfillment");
  });

  it("flags a dedicated fulfillment product by title", () => {
    const c = classifyOrder(
      base({
        totalCents: 0,
        receivedCents: 0,
        paymentGatewayNames: [],
        lineItems: [
          { title: "Esses Issue 06 Prepaid Subscription Fulfillment", sellingPlanId: null },
        ],
      }),
    );
    expect(c.countsAsRevenue).toBe(false);
    expect(c.revenueExternalSource).toBe("prepaid");
  });

  it("counts a real Skio subscription order (selling plan, money received)", () => {
    const c = classifyOrder(
      base({
        totalCents: 3000,
        receivedCents: 3000,
        lineItems: [{ title: "Esses Subscription", sellingPlanId: "gid://shopify/SellingPlan/1" }],
      }),
    );
    expect(c.orderType).toBe("subscription_shopify");
    expect(c.countsAsRevenue).toBe(true);
  });

  it("counts a free 100%-off Skio first order (total 0) as real subscription revenue", () => {
    // The important negative case: $0 total must NOT trip the zero-received
    // fulfillment heuristic — it's a genuine (free) acquisition order.
    const c = classifyOrder(
      base({
        totalCents: 0,
        receivedCents: 0,
        paymentGatewayNames: [],
        lineItems: [{ title: "Esses Subscription", sellingPlanId: "gid://shopify/SellingPlan/1" }],
      }),
    );
    expect(c.orderType).toBe("subscription_shopify");
    expect(c.countsAsRevenue).toBe(true);
  });

  it("counts a normal one-time purchase", () => {
    const c = classifyOrder(base());
    expect(c.orderType).toBe("one_time");
    expect(c.countsAsRevenue).toBe(true);
  });

  it("flags a $0-payment order for review (likely comp) and excludes it until confirmed", () => {
    // No payment collected through Shopify (received $0, no gateway) but the order
    // has value — likely a comp (watch party / member gift). Flagged, not counted.
    const c = classifyOrder(
      base({
        tags: [],
        appName: null,
        paymentGatewayNames: [],
        totalCents: 65326,
        receivedCents: 0,
        lineItems: [{ title: "Esses Issue 02 (Stockist Package)", sellingPlanId: null }],
      }),
    );
    expect(c.needsReview).toBe(true);
    expect(c.reviewReason).toBe("no_payment_collected");
    expect(c.countsAsRevenue).toBe(false);
    expect(c.orderType).toBe("one_time");
  });

  it("counts a normally-paid order and does not flag it for review", () => {
    const c = classifyOrder(base());
    expect(c.needsReview).toBe(false);
    expect(c.countsAsRevenue).toBe(true);
  });
});

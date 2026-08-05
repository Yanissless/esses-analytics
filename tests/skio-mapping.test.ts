import { describe, expect, it } from "vitest";
import { lineMrrCents, mapSkioSubscription } from "../src/connectors/skio/ingest";

// Mirrors a real Skio subscription (verified live 2026-07-28): billed annually
// (MONTH x12) at $25 per QUARTERLY delivery.
const ANNUAL_QUARTERLY = {
  id: "2ff4bb66-88b1-4717-ae21-a52965c35b05",
  platformId: "gid://shopify/SubscriptionContract/37935513887",
  status: "ACTIVE",
  createdAt: "2025-09-30T17:32:00.511445+00:00",
  cancelledAt: null,
  nextBillingDate: "2026-08-15T05:00:00+00:00",
  currencyCode: "USD",
  cyclesCompleted: 4,
  BillingPolicy: { interval: "MONTH", intervalCount: 12 },
  DeliveryPolicy: { interval: "MONTH", intervalCount: 3 },
  StorefrontUser: {
    id: "f2389af3-5128-4195-a41c-185e3aca190e",
    email: "subscriber@example.com",
    firstName: "Kerianne",
    lastName: "Green",
  },
  Orders: [
    { platformId: "gid://shopify/Order/7148936102175" },
    { platformId: "gid://shopify/Order/7300000000001" },
  ],
  SubscriptionLines: [
    {
      sellingPlanId: "8c71f792-83d4-400d-8df5-660c060f81b7", // Skio UUID
      priceWithoutDiscount: 25,
      quantity: 1,
      OriginalSellingPlan: {
        name: "Annual Payment, Quarterly Delivery",
        platformId: "gid://shopify/SellingPlan/6592004383",
      },
      ProductVariant: { platformId: "gid://shopify/ProductVariant/48997761089823" },
    },
  ],
};

describe("lineMrrCents — delivery cadence drives MRR", () => {
  it("$25 per quarterly delivery = $8.33/mo (not $25/12)", () => {
    expect(
      lineMrrCents(2500, 1, { interval: "MONTH", intervalCount: 3 }, { interval: "MONTH", intervalCount: 12 }),
    ).toBe(833);
  });

  it("$30 per quarterly delivery = $10.00/mo", () => {
    expect(lineMrrCents(3000, 1, { interval: "MONTH", intervalCount: 3 }, null)).toBe(1000);
  });

  it("falls back to the billing policy when no delivery policy exists", () => {
    expect(lineMrrCents(1200, 1, null, { interval: "YEAR", intervalCount: 1 })).toBe(100);
  });

  it("scales with quantity", () => {
    expect(lineMrrCents(1000, 3, { interval: "MONTH", intervalCount: 1 }, null)).toBe(3000);
  });
});

describe("mapSkioSubscription — enrichment only (Section 3)", () => {
  it("maps status, plan name, and the SHOPIFY selling-plan gid (not Skio's uuid)", () => {
    const m = mapSkioSubscription(ANNUAL_QUARTERLY);
    expect(m.meta.status).toBe("active");
    expect(m.meta.rawStatus).toBe("ACTIVE");
    expect(m.meta.sellingPlanName).toBe("Annual Payment, Quarterly Delivery");
    expect(m.meta.sellingPlanId).toBe("gid://shopify/SellingPlan/6592004383");
  });

  it("computes MRR from the delivery cadence", () => {
    expect(mapSkioSubscription(ANNUAL_QUARTERLY).meta.mrrAmount).toBe(833);
  });

  it("extracts numeric Shopify order ids for direct linking", () => {
    const m = mapSkioSubscription(ANNUAL_QUARTERLY);
    expect(m.shopifyOrderIds).toEqual(["7148936102175", "7300000000001"]);
  });

  it("carries customer identity for unification", () => {
    const m = mapSkioSubscription(ANNUAL_QUARTERLY);
    expect(m.customer.email).toBe("subscriber@example.com");
    expect(m.customer.name).toBe("Kerianne Green");
    expect(m.customer.skioStorefrontUserId).toBe("f2389af3-5128-4195-a41c-185e3aca190e");
  });

  it("maps a cancelled subscription's churn date", () => {
    const m = mapSkioSubscription({
      ...ANNUAL_QUARTERLY,
      status: "CANCELLED",
      cancelledAt: "2025-11-30T20:21:43.217+00:00",
    });
    expect(m.meta.status).toBe("canceled");
    expect(m.meta.cancelledAt?.toISOString()).toBe("2025-11-30T20:21:43.217Z");
  });

  it("produces ONLY subscription-metadata fields — no order/revenue amounts", () => {
    const keys = Object.keys(mapSkioSubscription(ANNUAL_QUARTERLY).meta);
    for (const forbidden of ["totalAmount", "revenue", "amountReceivedAmount", "countsAsRevenue"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys).toEqual(
      expect.arrayContaining(["status", "mrrAmount", "cancelledAt", "sellingPlanId"]),
    );
  });
});

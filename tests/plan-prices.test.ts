import { describe, expect, it } from "vitest";
import {
  looksPrepaid,
  PLAN_RENEWAL_PRICES,
  renewalChargeCents,
} from "../src/metrics/plan-prices";

/**
 * The forecast was understating the annual book by 3.8x — $26.28/yr against a real $100/yr
 * across 865 subscriptions. These tests pin the fix and, more importantly, pin the refusal to
 * present a derived figure as a known one.
 */
describe("renewalChargeCents", () => {
  it("uses the known list price for the annual prepaid plan", () => {
    const r = renewalChargeCents({
      sellingPlanName: "Annual Payment, Quarterly Delivery",
      // Deliberately the WRONG stored MRR, to prove the known price wins over arithmetic.
      mrrCents: 211,
      billingIntervalCount: 12,
    });
    expect(r.cents).toBe(100_00);
    expect(r.source).toBe("known-plan");
  });

  it("derives from MRR for plans that bill and deliver on the same cadence", () => {
    // Sam confirmed the quarterly plan is accurate this way: $10.26 MRR x 3 months.
    const r = renewalChargeCents({
      sellingPlanName: "Quarterly Subscription",
      mrrCents: 1026,
      billingIntervalCount: 3,
    });
    expect(r.cents).toBe(3078);
    expect(r.source).toBe("derived-from-mrr");
  });

  it("labels a derived figure as derived, never as known", () => {
    // The whole point: a page must be able to tell the reader which it is looking at.
    const r = renewalChargeCents({
      sellingPlanName: "Some New Plan",
      mrrCents: 500,
      billingIntervalCount: 6,
    });
    expect(r.source).toBe("derived-from-mrr");
  });

  it("returns unknown rather than zero when there is nothing to work from", () => {
    // Zero would sum silently into a total and understate it. Null cannot.
    expect(renewalChargeCents({ sellingPlanName: null, mrrCents: 0, billingIntervalCount: 12 }))
      .toMatchObject({ cents: null, source: "unknown" });
  });

  it("matches the plan name exactly, so a renamed plan fails loudly", () => {
    // A near-miss must NOT silently fall back to the broken arithmetic while looking fine.
    const r = renewalChargeCents({
      sellingPlanName: "Annual Payment Quarterly Delivery",
      mrrCents: 211,
      billingIntervalCount: 12,
    });
    expect(r.source).toBe("derived-from-mrr");
    expect(r.cents).not.toBe(100_00);
  });
});

describe("looksPrepaid", () => {
  it("recognises the plans whose billing and delivery cadences differ", () => {
    expect(looksPrepaid("Annual Payment, Quarterly Delivery")).toBe(true);
    expect(looksPrepaid("Prepaid 12 month")).toBe(true);
    expect(looksPrepaid("Quarterly Subscription")).toBe(false);
    expect(looksPrepaid(null)).toBe(false);
  });

  it("every hand-entered price is for a plan it flags", () => {
    // A price in the table for a plan that is NOT prepaid would mean the table is being used
    // to paper over some other bug, which is worth catching here.
    for (const name of Object.keys(PLAN_RENEWAL_PRICES)) {
      expect(looksPrepaid(name)).toBe(true);
    }
  });
});

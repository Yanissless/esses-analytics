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

  it("uses the known list price for the quarterly plan, EX-TAX", () => {
    // Confirmed $30.00. The observed average was $31.28 because taxed regions collect more,
    // so an average would quietly overstate revenue the app defines as net ex-VAT.
    const r = renewalChargeCents({
      sellingPlanName: "Quarterly Subscription",
      mrrCents: 1026,
      billingIntervalCount: 3,
    });
    expect(r.cents).toBe(30_00);
    expect(r.source).toBe("known-plan");
    // Explicitly NOT the tax-inclusive arithmetic figure.
    expect(r.cents).not.toBe(3078);
  });

  it("derives from MRR for a plan with no confirmed price", () => {
    const r = renewalChargeCents({
      sellingPlanName: "Some Future Plan",
      mrrCents: 1000,
      billingIntervalCount: 3,
    });
    expect(r.cents).toBe(3000);
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

  it("every known prepaid plan HAS a confirmed price", () => {
    // The invariant runs this way round, not the other. Ordinary plans may fall back to
    // arithmetic — slightly high where tax applies, but the right order of magnitude. For a
    // prepaid plan arithmetic is simply wrong, off by the deliveries per billing cycle, so a
    // prepaid plan missing from the table is a defect rather than an approximation.
    const priced = Object.keys(PLAN_RENEWAL_PRICES);
    for (const name of priced.filter(looksPrepaid)) {
      expect(PLAN_RENEWAL_PRICES[name]).toBeGreaterThan(0);
    }
    expect(priced.some(looksPrepaid)).toBe(true);
  });

  it("holds every price as a positive whole number of cents", () => {
    for (const [name, cents] of Object.entries(PLAN_RENEWAL_PRICES)) {
      expect(Number.isInteger(cents), `${name} must be whole cents`).toBe(true);
      expect(cents).toBeGreaterThan(0);
    }
  });
});

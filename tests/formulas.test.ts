import { describe, expect, it } from "vitest";
import {
  amer,
  aov,
  breakevenMer,
  cac,
  cacPaybackMonths,
  contributionMargin,
  historicalLtv,
  mer,
  monthlyChurnRate,
  predictiveSubscriptionLtv,
  ratio,
  retentionRate,
  roas,
  twelveMonthLtv,
} from "../src/metrics/formulas";

/**
 * Section 14 calls out the metric formulas as one of two places a subtle bug would
 * silently produce wrong numbers. Every case below is hand-checkable.
 */

describe("ratio — the undefined-vs-zero contract", () => {
  it("divides normally", () => {
    expect(ratio(1000, 250)).toBe(4);
  });

  it("returns null (not Infinity) when the denominator is zero", () => {
    // Infinity would poison any average computed downstream.
    expect(ratio(1000, 0)).toBeNull();
  });

  it("returns null (not 0) rather than implying terrible performance", () => {
    expect(ratio(0, 0)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(ratio(Number.NaN, 5)).toBeNull();
    expect(ratio(5, Number.NaN)).toBeNull();
  });

  it("keeps a legitimate zero numerator as 0", () => {
    expect(ratio(0, 100)).toBe(0);
  });
});

describe("MER and aMER", () => {
  it("MER = revenue ÷ spend", () => {
    // $10,000 revenue on $2,500 spend → 4.0
    expect(mer(1_000_000, 250_000)).toBe(4);
  });

  it("aMER isolates new-customer revenue", () => {
    // Same spend, but only $3,000 came from new customers → 1.2
    expect(amer(300_000, 250_000)).toBeCloseTo(1.2, 10);
  });

  it("aMER can be far below MER when revenue is mostly repeat — the case that matters", () => {
    const blended = mer(1_000_000, 250_000);
    const acquisition = amer(100_000, 250_000);
    expect(blended).toBe(4);
    expect(acquisition).toBeCloseTo(0.4, 10);
    expect(acquisition as number).toBeLessThan(blended as number);
  });

  it("is null with zero ad spend rather than infinite", () => {
    expect(mer(1_000_000, 0)).toBeNull();
    expect(amer(1_000_000, 0)).toBeNull();
  });
});

describe("ROAS and CAC", () => {
  it("ROAS is channel revenue ÷ channel spend", () => {
    expect(roas(90_000, 30_000)).toBe(3);
  });

  it("CAC is spend ÷ new customers", () => {
    // $2,500 spend, 100 new customers → $25.00 CAC
    expect(cac(250_000, 100)).toBe(2500);
  });

  it("CAC is null when no customers were acquired, not zero", () => {
    expect(cac(250_000, 0)).toBeNull();
  });

  it("CAC is null with zero ad spend — 'customers are free' is not a finding", () => {
    // Arithmetically $0, but on a dashboard that reads as spectacular performance
    // rather than "no paid acquisition measured". MER is null here too.
    expect(cac(0, 3644)).toBeNull();
  });
});

describe("CAC payback period", () => {
  it("computes months from CAC, monthly revenue and gross margin", () => {
    // $30 CAC; $10/mo revenue at 50% margin = $5/mo contribution → 6 months.
    expect(cacPaybackMonths(3000, 1000, 0.5)).toBe(6);
  });

  it("is null when CAC is zero or missing — not instant payback", () => {
    expect(cacPaybackMonths(0, 1000, 0.5)).toBeNull();
    expect(cacPaybackMonths(null, 1000, 0.5)).toBeNull();
  });

  it("is null when there is no monthly contribution to recover from", () => {
    expect(cacPaybackMonths(3000, 0, 0.5)).toBeNull();
    expect(cacPaybackMonths(3000, 1000, 0)).toBeNull();
  });
});

describe("contribution margin tiers", () => {
  const base = {
    netRevenueCents: 10_000,
    cogsCents: 4_000,
    fulfillmentCents: 1_500,
    processingCents: 300,
    discountsCents: 0,
    adSpendCents: 2_000,
  };

  it("subtracts in the right order: CM1 → CM2 → CM3", () => {
    const m = contributionMargin(base);
    expect(m.cm1Cents).toBe(6_000); // 10,000 − 4,000
    expect(m.cm2Cents).toBe(4_200); // 6,000 − 1,500 − 300
    expect(m.cm3Cents).toBe(2_200); // 4,200 − 2,000
  });

  it("expresses each tier as a share of net revenue", () => {
    const m = contributionMargin(base);
    expect(m.cm1Pct).toBeCloseTo(0.6, 10);
    expect(m.cm2Pct).toBeCloseTo(0.42, 10);
    expect(m.cm3Pct).toBeCloseTo(0.22, 10);
  });

  it("goes negative when costs exceed revenue instead of clamping at zero", () => {
    const m = contributionMargin({ ...base, cogsCents: 9_000, adSpendCents: 5_000 });
    expect(m.cm3Cents).toBeLessThan(0);
  });

  it("returns null percentages on zero revenue but still reports the cash amounts", () => {
    const m = contributionMargin({ ...base, netRevenueCents: 0 });
    expect(m.cm1Pct).toBeNull();
    expect(m.cm1Cents).toBe(-4_000);
  });
});

describe("AOV", () => {
  it("divides by PAID orders (the $0-order trap from the live data)", () => {
    expect(aov(14_665_011, 2759)).toBeCloseTo(5315.3, 0);
  });
  it("is null with no paid orders", () => {
    expect(aov(0, 0)).toBeNull();
  });
});

describe("LTV variants", () => {
  it("historical LTV averages realised value per customer", () => {
    expect(historicalLtv(1_000_000, 250)).toBe(4000); // $40.00
  });

  it("12-month LTV windows to the cohort's first year", () => {
    expect(twelveMonthLtv(500_000, 100)).toBe(5000); // $50.00
  });

  it("predictive subscription LTV = MRR × implied lifespan (1/churn)", () => {
    // $10/mo at 5% monthly churn → 20 months → $200.
    expect(predictiveSubscriptionLtv(1000, 0.05)).toBe(20_000);
  });

  it("caps lifespan when churn is zero instead of returning Infinity", () => {
    expect(predictiveSubscriptionLtv(1000, 0, 60)).toBe(60_000);
  });

  it("caps implausibly long lifespans from tiny churn", () => {
    // 0.1% churn implies 1000 months; the cap keeps it honest.
    expect(predictiveSubscriptionLtv(1000, 0.001, 60)).toBe(60_000);
  });

  it("rejects nonsense inputs with null", () => {
    expect(predictiveSubscriptionLtv(-100, 0.05)).toBeNull();
    expect(predictiveSubscriptionLtv(1000, -0.1)).toBeNull();
  });
});

describe("churn, retention and breakeven MER", () => {
  it("churn = lost ÷ starting count", () => {
    expect(monthlyChurnRate(5, 100)).toBeCloseTo(0.05, 10);
  });

  it("retention is 1 − churn, and null when churn is unknown", () => {
    expect(retentionRate(0.05)).toBeCloseTo(0.95, 10);
    expect(retentionRate(null)).toBeNull();
  });

  it("breakeven MER is the inverse of contribution-margin rate", () => {
    // At Esses' actual 34% CM2, breakeven MER ≈ 2.94.
    expect(breakevenMer(0.34)).toBeCloseTo(2.941, 3);
  });

  it("is null when margin is zero or negative — no MER can save it", () => {
    expect(breakevenMer(0)).toBeNull();
    expect(breakevenMer(-0.1)).toBeNull();
  });
});

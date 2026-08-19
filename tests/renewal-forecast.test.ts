import { describe, expect, it } from "vitest";
import {
  checkPriceDivergence,
  PRICE_DIVERGENCE_FACTOR,
  type CadenceBreakdown,
} from "../src/metrics/renewal-forecast";

const cad = (intervalCount: number, avgMrrCents: number, subs = 100): CadenceBreakdown => ({
  intervalCount,
  subscriptions: subs,
  avgMrrCents,
  avgChargeCents: avgMrrCents * intervalCount,
  annualisedCents: avgMrrCents * 12,
});

/**
 * The forecast's headline is a total, and a total is only as good as the per-sub prices under
 * it. On the real book the two cadences imply ~$125/yr against ~$26/yr for what should be a
 * comparable product — a 4.8x gap that either is real or means one cadence's MRR
 * normalisation is wrong. Either way it must be stated, not silently summed.
 */
describe("checkPriceDivergence", () => {
  it("flags cadences whose annualised prices disagree wildly", () => {
    // The real shape: quarterly at $10.43 MRR against annual at $2.19.
    const w = checkPriceDivergence([cad(3, 1043, 893), cad(12, 219, 892)]);
    expect(w).not.toBeNull();
    expect(w).toContain("4.8x");
    expect(w).toContain("Verify");
  });

  it("stays quiet when the cadences agree", () => {
    // Same monthly price either way is the healthy case and needs no warning.
    expect(checkPriceDivergence([cad(3, 1000), cad(12, 1000)])).toBeNull();
  });

  it("uses the documented threshold", () => {
    const under = checkPriceDivergence([cad(3, 100), cad(12, 100 * PRICE_DIVERGENCE_FACTOR - 1)]);
    const over = checkPriceDivergence([cad(3, 100), cad(12, 100 * PRICE_DIVERGENCE_FACTOR)]);
    expect(under).toBeNull();
    expect(over).not.toBeNull();
  });

  it("cannot compare a single cadence against itself", () => {
    expect(checkPriceDivergence([cad(3, 1043)])).toBeNull();
    expect(checkPriceDivergence([])).toBeNull();
  });

  it("ignores cadences with no subscriptions or no price", () => {
    // An empty cadence row would otherwise divide a real price by zero and always warn.
    expect(checkPriceDivergence([cad(3, 1000), cad(12, 0, 0)])).toBeNull();
  });
});

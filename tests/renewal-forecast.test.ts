import { describe, expect, it } from "vitest";
import {
  checkPriceDivergence,
  MIN_SUBS_FOR_DIVERGENCE,
  PRICE_DIVERGENCE_FACTOR,
  type CadenceBreakdown,
} from "../src/metrics/renewal-forecast";

const cad = (
  intervalCount: number,
  avgMrrCents: number,
  subs = 100,
  source = "skio",
): CadenceBreakdown => ({
  source,
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

  it("only compares cadences that could meaningfully differ", () => {
    // The check is handed one source's cadences at a time by getRenewalForecast. Across
    // sources it fired on a Stripe monthly plan at $60/yr against a Skio quarterly at
    // $121.76/yr — different products through different systems, so the 2x gap carried no
    // information. This asserts the function itself still flags a real within-source gap.
    const withinSkio = checkPriceDivergence([cad(3, 1043, 893, "skio"), cad(12, 219, 892, "skio")]);
    expect(withinSkio).not.toBeNull();
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

/**
 * The divergence check needs a volume floor for the same reason every other graded surface in
 * this codebase does. Scoping it per source exposed the gap: it fired on a SINGLE $5/month
 * Stripe subscription against 150 quarterly ones and called it a 2x pricing anomaly.
 */
describe("checkPriceDivergence volume floor", () => {
  it("ignores a cadence with too few subscriptions to establish a price", () => {
    // One subscription on an unusual plan is not evidence that a cadence is mispriced.
    const w = checkPriceDivergence([
      cad(3, 1000, 150, "stripe"),
      cad(1, 500, 1, "stripe"),
    ]);
    expect(w).toBeNull();
  });

  it("still flags a divergence once both cadences clear the floor", () => {
    const w = checkPriceDivergence([
      cad(3, 1000, MIN_SUBS_FOR_DIVERGENCE, "stripe"),
      cad(1, 500, MIN_SUBS_FOR_DIVERGENCE, "stripe"),
    ]);
    expect(w).not.toBeNull();
  });

  it("uses the documented floor exactly", () => {
    const under = checkPriceDivergence([
      cad(3, 1000, 150, "skio"),
      cad(12, 100, MIN_SUBS_FOR_DIVERGENCE - 1, "skio"),
    ]);
    const at = checkPriceDivergence([
      cad(3, 1000, 150, "skio"),
      cad(12, 100, MIN_SUBS_FOR_DIVERGENCE, "skio"),
    ]);
    expect(under).toBeNull();
    expect(at).not.toBeNull();
  });
});

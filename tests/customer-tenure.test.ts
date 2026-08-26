import { describe, expect, it } from "vitest";
import {
  MIN_COHORT_TO_RATE,
  rateCohort,
  share,
} from "../src/metrics/customer-tenure";

describe("share", () => {
  it("divides", () => {
    expect(share(844, 2382)).toBeCloseTo(0.3543, 4);
  });

  it("returns null rather than 0 or Infinity on an empty denominator", () => {
    // A repeat rate with nobody to describe is not zero — it is unknown, and zero would render
    // as "0% repeat" which reads as a finding.
    expect(share(0, 0)).toBeNull();
    expect(share(5, 0)).toBeNull();
  });
});

describe("rateCohort", () => {
  it("divides by matured, not by the whole cohort", () => {
    // THE rule. Counting someone acquired last week as "did not convert" understates the rate by
    // however many recent signups there are — the trap the promo cohorts hit, where 306 of 311
    // "failures" included people who had not yet been asked to renew.
    const r = rateCohort({
      route: "acquisition_gift",
      customers: 1783,
      matured: 1000,
      everPaid: 400,
      repeatBuyers: 150,
    });
    expect(r.conversionRate).toBeCloseTo(0.4);
    expect(r.repeatRate).toBeCloseTo(0.15);
    // The full cohort is still reported, so the maturity gap is visible.
    expect(r.customers).toBe(1783);
  });

  it("withholds both rates below the volume floor", () => {
    const r = rateCohort({
      route: "comp",
      customers: 12,
      matured: MIN_COHORT_TO_RATE - 1,
      everPaid: 6,
      repeatBuyers: 2,
    });
    expect(r.conversionRate).toBeNull();
    expect(r.repeatRate).toBeNull();
    // Counts survive — they are facts; it is the rate that would mislead.
    expect(r.everPaid).toBe(6);
  });

  it("publishes a rate exactly at the floor", () => {
    const r = rateCohort({
      route: "paid",
      customers: 50,
      matured: MIN_COHORT_TO_RATE,
      everPaid: MIN_COHORT_TO_RATE,
      repeatBuyers: 5,
    });
    expect(r.conversionRate).toBe(1);
  });

  it("returns null rather than dividing by zero when nothing has matured", () => {
    // A brand-new route: everyone acquired too recently to judge.
    const r = rateCohort({
      route: "acquisition_gift",
      customers: 40,
      matured: 0,
      everPaid: 0,
      repeatBuyers: 0,
    });
    expect(r.conversionRate).toBeNull();
    expect(r.repeatRate).toBeNull();
  });

  it("can report a 100% conversion, which is what a paid acquisition is", () => {
    // Someone acquired by paying has, by definition, paid. The route exists as a baseline to
    // compare the free routes against.
    const r = rateCohort({
      route: "paid",
      customers: 1319,
      matured: 1200,
      everPaid: 1200,
      repeatBuyers: 500,
    });
    expect(r.conversionRate).toBe(1);
    expect(r.repeatRate).toBeCloseTo(500 / 1200);
  });
});

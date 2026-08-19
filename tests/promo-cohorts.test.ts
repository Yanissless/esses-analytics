import { describe, expect, it } from "vitest";
import { gradeCohort, MIN_MATURED_TO_RATE } from "../src/metrics/promo-cohorts";
import {
  ACQUISITION_PROMO_CODES,
  ACQUISITION_PROMO_SQL_REGEX,
  isAcquisitionPromo,
} from "../src/metrics/acquisition-promos";

/**
 * A free-issue promo is judged on how many paid AFTERWARDS, and the trap is that the cohorts
 * have wildly different ages. Read flat on 18 Aug 2026 the real data said THANKYOU100 converted
 * 3.4% and D1G90FJ1GQ28 converted 60.4% — but THANKYOU100's members mostly sit on the annual
 * plan and had not been asked to pay yet. These tests pin the refusal to publish a rate the
 * data cannot support.
 */
describe("gradeCohort", () => {
  it("refuses to grade a cohort where nobody has reached a renewal date", () => {
    // The real FREEFIRSTISSUE case: 877 customers, 14 days old, quarterly renewal at ~90 days.
    const g = gradeCohort(877, 0);
    expect(g.rateable).toBe(false);
    expect(g.caveat).toContain("elapsed time");
  });

  it("refuses to grade a cohort with only a handful matured", () => {
    // The real THANKYOU100 case: 15 of 197 matured. A rate off 15 swings on the next two.
    const g = gradeCohort(197, MIN_MATURED_TO_RATE - 5);
    expect(g.rateable).toBe(false);
    expect(g.caveat).toContain("noise");
  });

  it("grades a mature cohort but still says who was excluded", () => {
    // The real D1G90FJ1GQ28 case: 780 of 797 matured. The rate is publishable, but a reader
    // comparing it to the cohort size needs to know the denominator is not 797.
    const g = gradeCohort(797, 780);
    expect(g.rateable).toBe(true);
    expect(g.caveat).toContain("17 of 797");
  });

  it("has no caveat when the whole cohort has matured", () => {
    const g = gradeCohort(500, 500);
    expect(g.rateable).toBe(true);
    expect(g.caveat).toBeNull();
  });

  it("becomes rateable exactly at the documented threshold", () => {
    expect(gradeCohort(100, MIN_MATURED_TO_RATE - 1).rateable).toBe(false);
    expect(gradeCohort(100, MIN_MATURED_TO_RATE).rateable).toBe(true);
  });
});

describe("acquisition promo codes", () => {
  it("matches case-insensitively and ignores surrounding space", () => {
    // Shopify returns these with inconsistent case — the real data holds both "F34HZRHDS"
    // and "f34hzrhds" for the same code.
    expect(isAcquisitionPromo("freefirstissue")).toBe(true);
    expect(isAcquisitionPromo("  FREEFIRSTISSUE  ")).toBe(true);
    expect(isAcquisitionPromo("f34hzrhds")).toBe(true);
  });

  it("does not match operational or ordinary marketing codes", () => {
    // "Prepaid credit" is the mechanism by which an ALREADY-PAID annual subscription delivers
    // at $0. Treating it as a giveaway would double-count $100 of collected revenue as a cost.
    expect(isAcquisitionPromo("Prepaid credit")).toBe(false);
    expect(isAcquisitionPromo("BLACKFRIDAY50")).toBe(false);
    expect(isAcquisitionPromo(null)).toBe(false);
    expect(isAcquisitionPromo("")).toBe(false);
  });

  it("anchors the SQL regex so a code cannot match by prefix", () => {
    // Unanchored, "THANKYOU100" would also match a future "THANKYOU1000" and silently absorb
    // a different promo's cost into this one's cohort.
    expect(ACQUISITION_PROMO_SQL_REGEX.startsWith("^(")).toBe(true);
    expect(ACQUISITION_PROMO_SQL_REGEX.endsWith(")$")).toBe(true);
    for (const c of ACQUISITION_PROMO_CODES) {
      expect(ACQUISITION_PROMO_SQL_REGEX).toContain(c);
    }
  });

  it("lists no duplicates, which would double-count a cohort's cost", () => {
    const upper = ACQUISITION_PROMO_CODES.map((c) => c.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
  });
});

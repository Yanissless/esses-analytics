import { describe, expect, it } from "vitest";
import { gradeCohort, MIN_MATURED_TO_RATE } from "../src/metrics/promo-cohorts";
import {
  ACQUISITION_PROMO_SQL_REGEX,
  ALL_PROMO_SQL_REGEX,
  isAcquisitionPromo,
  isComp,
  isRegisteredPromo,
  PROMO_DEFINITIONS,
  promoPurpose,
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

describe("promo registry", () => {
  it("matches case-insensitively and ignores surrounding space", () => {
    // Shopify returns these inconsistently — the real data holds both "F34HZRHDS" and
    // "f34hzrhds" for the same code.
    expect(isRegisteredPromo("freefirstissue")).toBe(true);
    expect(isRegisteredPromo("  FREEFIRSTISSUE  ")).toBe(true);
    expect(isRegisteredPromo("F34HZRHDS")).toBe(true);
  });

  it("keeps the three purposes apart", () => {
    // Sam, 18 Aug 2026. Collapsing these into one "free issue promo" bucket was the mistake
    // the registry exists to prevent.
    expect(promoPurpose("FREEFIRSTISSUE")).toBe("acquisition");
    expect(promoPurpose("D1G90FJ1GQ28")).toBe("acquisition");
    expect(promoPurpose("THANKYOU100")).toBe("win-back");
    expect(promoPurpose("f34hzrhds")).toBe("comp");
  });

  it("counts only free-issue offers as acquisition cost", () => {
    // A VIP comp is a relationship cost and a win-back is spent on someone already acquired
    // once. Charging either to CAC would overstate the cost of finding NEW subscribers.
    expect(isAcquisitionPromo("FREEFIRSTISSUE")).toBe(true);
    expect(isAcquisitionPromo("THANKYOU100")).toBe(false);
    expect(isAcquisitionPromo("f34hzrhds")).toBe(false);
  });

  it("identifies comps, which must never be given a conversion rate", () => {
    // These recipients were never meant to pay. A 0% rate would invent a failure.
    expect(isComp("f34hzrhds")).toBe(true);
    expect(isComp("FREEFIRSTISSUE")).toBe(false);
  });

  it("does not match operational or ordinary marketing codes", () => {
    // "Prepaid credit" is how an ALREADY-PAID annual subscription delivers at $0. Treating it
    // as a giveaway would book $100 of collected revenue as a cost.
    expect(isRegisteredPromo("Prepaid credit")).toBe(false);
    expect(isRegisteredPromo("BLACKFRIDAY50")).toBe(false);
    expect(isRegisteredPromo(null)).toBe(false);
    expect(isRegisteredPromo("")).toBe(false);
  });

  it("anchors both SQL regexes so a code cannot match by prefix", () => {
    // Unanchored, "THANKYOU100" would also match a future "THANKYOU1000" and silently absorb
    // a different promo's cost into this cohort.
    for (const rx of [ALL_PROMO_SQL_REGEX, ACQUISITION_PROMO_SQL_REGEX]) {
      expect(rx.startsWith("^(")).toBe(true);
      expect(rx.endsWith(")$")).toBe(true);
    }
    // The acquisition regex must exclude the comp and win-back codes.
    expect(ACQUISITION_PROMO_SQL_REGEX).not.toContain("f34hzrhds");
    expect(ACQUISITION_PROMO_SQL_REGEX).not.toContain("THANKYOU100");
    expect(ALL_PROMO_SQL_REGEX).toContain("f34hzrhds");
  });

  it("lists no duplicate codes, which would double-count a cohort's cost", () => {
    const upper = PROMO_DEFINITIONS.map((d) => d.code.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
  });

  it("gives every code a human label, since the codes themselves are opaque", () => {
    // "D1G90FJ1GQ28" tells a reader nothing. Two of these four are Skio-generated.
    for (const d of PROMO_DEFINITIONS) {
      expect(d.label.length).toBeGreaterThan(10);
    }
  });
});

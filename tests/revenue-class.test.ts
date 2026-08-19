import { describe, expect, it } from "vitest";
import { isGiveaway, REVENUE_CLASSES } from "../src/metrics/revenue-class";
import {
  ACQUISITION_PROMO_SQL_REGEX,
  COMP_PROMO_SQL_REGEX,
  PROMO_DEFINITIONS,
} from "../src/metrics/acquisition-promos";

/**
 * `revenue_class` used to be defined twice — once in metrics/order-profit.ts and once in
 * metrics/rollup.ts, the copy carrying the comment "Must match metrics/order-profit.ts
 * exactly." CLAUDE.md rule 1 says there is a single CASE, and there wasn't; the duplication
 * survived because both copies happened to be right, so nothing ever failed.
 *
 * There is now one definition. These tests guard the parts of it that are expressible without
 * a database — chiefly that the two promo regexes partition the registry, since an overlap
 * would let one order match two branches and a gap would let a giveaway fall through to
 * `prepaid_delivery`, which is the bug being fixed.
 */
describe("revenue class", () => {
  it("has exactly the four documented classes", () => {
    expect([...REVENUE_CLASSES].sort()).toEqual(
      ["acquisition_gift", "comp", "paid", "prepaid_delivery"].sort(),
    );
  });

  it("counts both giveaway classes as giveaways, and neither of the others", () => {
    expect(isGiveaway("acquisition_gift")).toBe(true);
    expect(isGiveaway("comp")).toBe(true);
    expect(isGiveaway("paid")).toBe(false);
    expect(isGiveaway("prepaid_delivery")).toBe(false);
  });
});

describe("the two promo regexes partition the registry", () => {
  const acq = new RegExp(ACQUISITION_PROMO_SQL_REGEX, "i");
  const comp = new RegExp(COMP_PROMO_SQL_REGEX, "i");

  it("puts every registered code in exactly one of them", () => {
    // A code in BOTH would match two CASE branches and its class would depend on branch
    // order rather than on intent. A code in NEITHER would fall through to
    // prepaid_delivery — silently reproducing the bug this change fixes.
    for (const d of PROMO_DEFINITIONS) {
      const inAcq = acq.test(d.code);
      const inComp = comp.test(d.code);
      expect(
        Number(inAcq) + Number(inComp),
        `${d.code} (${d.purpose}) must be in exactly one regex`,
      ).toBe(1);
    }
  });

  it("routes each purpose to the right side", () => {
    for (const d of PROMO_DEFINITIONS) {
      if (d.purpose === "acquisition") {
        expect(acq.test(d.code), `${d.code} should be acquisition`).toBe(true);
      } else {
        expect(comp.test(d.code), `${d.code} should be comp-side`).toBe(true);
      }
    }
  });

  it("matches nothing outside the registry", () => {
    // "Prepaid credit" is how an already-paid annual subscription delivers at $0. If it
    // matched, $100 of collected revenue would be reclassified as a giveaway cost.
    for (const other of ["Prepaid credit", "BLACKFRIDAY50", "Delivery Issue", "", "FREEFIRST"]) {
      expect(acq.test(other), `${other} must not be acquisition`).toBe(false);
      expect(comp.test(other), `${other} must not be comp-side`).toBe(false);
    }
  });

  it("is anchored, so a longer code cannot match by prefix", () => {
    // Unanchored, THANKYOU100 would also match THANKYOU1000 and absorb a future promo's
    // cost into the wrong class.
    expect(acq.test("FREEFIRSTISSUE2")).toBe(false);
    expect(comp.test("THANKYOU1000")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  breakevenCogsPerUnitCents,
  marginAtCogs,
  type BreakevenInput,
} from "../src/metrics/cogs-scenario";

/** Roughly the live paid-boundary shape, in cents. */
const live: BreakevenInput = {
  netRevenueCents: 14_456_180,
  otherCostsCents: 2_774_946,
  adSpendCents: 2_952_385,
  units: 3_542,
};

describe("breakevenCogsPerUnitCents", () => {
  it("solves for the per-unit cost where CM3 is exactly zero", () => {
    const be = breakevenCogsPerUnitCents(live);
    expect(be).not.toBeNull();
    // Feeding the breakeven back in must land CM3 on zero (within rounding).
    const at = marginAtCogs(live, be as number);
    expect(Math.abs(at.cm3Cents)).toBeLessThanOrEqual(live.units);
  });

  it("is the figure to compare a printer quote against", () => {
    // Sanity: with this revenue and these costs there is real headroom per copy.
    expect(breakevenCogsPerUnitCents(live)).toBeGreaterThan(1000);
  });

  it("returns null with no units rather than dividing by zero", () => {
    expect(breakevenCogsPerUnitCents({ ...live, units: 0 })).toBeNull();
    expect(breakevenCogsPerUnitCents({ ...live, units: -5 })).toBeNull();
  });

  /**
   * A negative breakeven is meaningful, not a bug: other costs alone already exceed
   * revenue, so no print price would make CM3 positive. Clamping it to zero would
   * imply a free print run fixes the problem.
   */
  it("reports a negative breakeven honestly", () => {
    const underwater: BreakevenInput = {
      netRevenueCents: 100_000,
      otherCostsCents: 150_000,
      adSpendCents: 20_000,
      units: 1_000,
    };
    const be = breakevenCogsPerUnitCents(underwater);
    expect(be).not.toBeNull();
    expect(be as number).toBeLessThan(0);
  });
});

describe("marginAtCogs", () => {
  it("scales COGS by units and leaves every other cost untouched", () => {
    const a = marginAtCogs(live, 550);
    expect(a.cogsCents).toBe(550 * live.units);
    expect(a.cm1Cents).toBe(live.netRevenueCents - a.cogsCents);
    expect(a.cm2Cents).toBe(a.cm1Cents - live.otherCostsCents);
    expect(a.cm3Cents).toBe(a.cm2Cents - live.adSpendCents);
  });

  it("makes the $11.48 vs ~$5.50 question concrete", () => {
    const placeholder = marginAtCogs(live, 1148);
    const older = marginAtCogs(live, 550);
    // The gap between the two candidate print costs, across all units.
    expect(older.cm3Cents - placeholder.cm3Cents).toBe((1148 - 550) * live.units);
    expect(older.cm3Cents).toBeGreaterThan(placeholder.cm3Cents);
  });

  it("is monotonic — a cheaper copy can never reduce margin", () => {
    const costs = [400, 550, 700, 1148, 1300];
    const cm3s = costs.map((c) => marginAtCogs(live, c).cm3Cents);
    for (let i = 1; i < cm3s.length; i++) {
      expect(cm3s[i]).toBeLessThan(cm3s[i - 1]);
    }
  });

  it("returns a null margin % when there is no revenue to divide by", () => {
    const noRevenue = marginAtCogs({ ...live, netRevenueCents: 0 }, 550);
    expect(noRevenue.cm3Pct).toBeNull();
  });

  it("handles a zero per-unit cost as a real scenario, not an error", () => {
    // "What if printing were free?" is the ceiling on any COGS negotiation.
    const free = marginAtCogs(live, 0);
    expect(free.cogsCents).toBe(0);
    expect(free.cm1Cents).toBe(live.netRevenueCents);
  });
});

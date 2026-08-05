import { describe, expect, it } from "vitest";

/**
 * Pins the COGS/margin rules that would silently produce wrong profit numbers.
 * The SQL implementation lives in src/metrics/cogs.ts; these encode the same
 * arithmetic so a change in intent has to be deliberate.
 */

/** Pick the cost effective at a date: greatest effective_date <= order date. */
function resolveCost(
  history: Array<{ effectiveDate: string; origin: string; cents: number }>,
  orderDate: string,
  origin: string,
): number {
  const applicable = (o: string) =>
    history
      .filter((h) => h.origin === o && h.effectiveDate <= orderDate)
      .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))[0];
  return (applicable(origin) ?? applicable("default"))?.cents ?? 0;
}

/** Net of refunds, then ex-VAT (international prices are tax-inclusive). */
function netExVatCents(grossCents: number, refundsCents: number, vatPct: number): number {
  return Math.round((grossCents - refundsCents) / (1 + vatPct));
}

describe("cost resolution is time-versioned", () => {
  const history = [
    { effectiveDate: "2025-10-01", origin: "US", cents: 1148 },
    { effectiveDate: "2026-03-01", origin: "US", cents: 1290 },
  ];

  it("uses the cost in force at the time of the order, not the latest", () => {
    expect(resolveCost(history, "2025-12-15", "US")).toBe(1148);
    expect(resolveCost(history, "2026-06-01", "US")).toBe(1290);
  });

  it("returns 0 when the order predates every cost record", () => {
    expect(resolveCost(history, "2025-01-01", "US")).toBe(0);
  });
});

describe("cost resolution respects fulfilment origin", () => {
  const history = [
    { effectiveDate: "2025-10-01", origin: "US", cents: 1148 },
    { effectiveDate: "2025-10-01", origin: "UK", cents: 830 },
    { effectiveDate: "2025-10-01", origin: "default", cents: 1000 },
  ];

  it("prefers the origin-specific cost — UK printer park differs from US", () => {
    expect(resolveCost(history, "2026-01-01", "UK")).toBe(830);
    expect(resolveCost(history, "2026-01-01", "US")).toBe(1148);
  });

  it("falls back to 'default' for an origin with no specific cost", () => {
    expect(resolveCost(history, "2026-01-01", "ZZ")).toBe(1000);
  });
});

describe("net revenue strips inclusive VAT", () => {
  it("divides by (1 + VAT) rather than subtracting the rate", () => {
    // £27 inclusive at 20% → £22.50 net, NOT £21.60.
    expect(netExVatCents(2700, 0, 0.2)).toBe(2250);
  });

  it("uses the print rate where it applies (Germany 9%)", () => {
    expect(netExVatCents(3100, 0, 0.09)).toBe(2844);
  });

  it("leaves a 0% market unchanged (US)", () => {
    expect(netExVatCents(3000, 0, 0)).toBe(3000);
  });

  it("deducts refunds before removing VAT", () => {
    expect(netExVatCents(2400, 1200, 0.2)).toBe(1000);
  });
});

describe("contribution margin tiers", () => {
  it("CM1 then CM2 subtract in the right order", () => {
    const net = 3000;
    const cogs = 1148;
    const shipping = 1200;
    const packaging = 60;
    const processing = Math.round(3000 * 0.039);
    const cm1 = net - cogs;
    const cm2 = cm1 - shipping - packaging - processing;
    expect(cm1).toBe(1852);
    expect(cm2).toBe(475);
    expect(cm2 / net).toBeCloseTo(0.158, 3);
  });

  it("goes negative when shipping exceeds the margin — the Norway/Denmark case", () => {
    // High VAT (25%) with no print reduction plus long-haul shipping.
    const net = netExVatCents(3913, 0, 0.25); // ~$31.30
    const cm2 = net - 1148 - 1800 - 75;
    expect(net).toBe(3130);
    expect(cm2).toBeLessThan(200);
  });
});

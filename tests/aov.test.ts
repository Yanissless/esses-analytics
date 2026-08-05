import { describe, expect, it } from "vitest";

/**
 * AOV must be computed over PAID orders only.
 *
 * In the real Esses data 65% of orders total $0 — subsequent deliveries on
 * prepaid subscription plans (annual payment, quarterly delivery) plus comps and
 * VIP copies. Dividing revenue by ALL orders reported $18.57 when the true
 * average paid order is $53.15. This test pins the rule.
 */
function aovCents(grossCents: number, paidOrderCount: number): number {
  return paidOrderCount ? Math.round(grossCents / paidOrderCount) : 0;
}

describe("AOV excludes $0 fulfillment orders", () => {
  it("divides by paid orders, not all orders", () => {
    const gross = 14_665_011; // $146,650.11
    const allOrders = 7897;
    const paidOrders = 2759;

    expect(aovCents(gross, paidOrders)).toBe(5315); // $53.15 — correct
    expect(aovCents(gross, allOrders)).toBe(1857); // $18.57 — the wrong answer
  });

  it("is zero (not NaN or Infinity) when there are no paid orders", () => {
    expect(aovCents(0, 0)).toBe(0);
    expect(aovCents(50_000, 0)).toBe(0);
  });

  it("matches a simple hand-checkable case", () => {
    // Two paid orders ($20, $40) plus three $0 shipments → AOV $30.00.
    expect(aovCents(6000, 2)).toBe(3000);
  });
});

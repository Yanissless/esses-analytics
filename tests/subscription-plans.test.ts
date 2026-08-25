import { describe, expect, it } from "vitest";
import {
  cadenceFromMonths,
  cyclePriceCents,
  groupByCadence,
  isLive,
  stripeIntervalMonths,
  type PlanRow,
} from "../src/metrics/subscription-plans";

const row = (over: Partial<PlanRow> = {}): PlanRow => ({
  cadence: "quarterly",
  platform: "skio",
  planName: "Quarterly Subscription",
  line: "print",
  status: "active",
  subscriptions: 1,
  mrrCents: 1000,
  billingMonths: 3,
  ...over,
});

describe("stripeIntervalMonths", () => {
  it("converts a yearly interval to months", () => {
    // THE one that matters. Stripe sends interval='year', count=1 for the $100/year plan.
    // Read as the count alone it looks like a monthly plan, overstating how often it bills
    // twelvefold — and the resulting number is plausible, so nothing would flag it.
    expect(stripeIntervalMonths("year", 1)).toBe(12);
    expect(stripeIntervalMonths("year", 2)).toBe(24);
  });

  it("passes a monthly interval through", () => {
    expect(stripeIntervalMonths("month", 3)).toBe(3);
    expect(stripeIntervalMonths("month", 1)).toBe(1);
  });

  it("is case-insensitive, because the unit is free text from an API", () => {
    expect(stripeIntervalMonths("YEAR", 1)).toBe(12);
  });

  it("defaults a missing count to one rather than dropping the row", () => {
    expect(stripeIntervalMonths("year", null)).toBe(12);
  });

  it("returns null for a unit it does not understand", () => {
    // Null lands the row in `other`, where it is countable. A guess would hide it.
    expect(stripeIntervalMonths("fortnight", 1)).toBeNull();
    expect(stripeIntervalMonths(null, 1)).toBeNull();
  });

  it("refuses a non-positive count", () => {
    expect(stripeIntervalMonths("month", 0)).toBeNull();
    expect(stripeIntervalMonths("month", -3)).toBeNull();
  });
});

describe("cadenceFromMonths", () => {
  it("maps the cadences actually sold", () => {
    expect(cadenceFromMonths(1)).toBe("monthly");
    expect(cadenceFromMonths(3)).toBe("quarterly");
    expect(cadenceFromMonths(12)).toBe("annual");
  });

  it("puts anything else in other rather than rounding to a neighbour", () => {
    // A cadence nobody sells is a legacy price still billing or a mapping bug. Both are worth
    // seeing; folding a 6-month plan into annual would hide either.
    expect(cadenceFromMonths(6)).toBe("other");
    expect(cadenceFromMonths(null)).toBe("other");
  });
});

describe("isLive", () => {
  it("counts anything still expected to bill", () => {
    for (const s of ["active", "trialing", "past_due"]) expect(isLive(s)).toBe(true);
  });

  it("excludes ended subscriptions and unknown status", () => {
    for (const s of ["canceled", "expired", "unpaid", "paused"]) expect(isLive(s)).toBe(false);
    // Skio sends nulls. Counting those as live would inflate the book by 680 subscriptions.
    expect(isLive(null)).toBe(false);
  });
});

describe("cyclePriceCents", () => {
  it("takes a Skio price from the shared table", () => {
    expect(
      cyclePriceCents({ platform: "skio", planName: "Quarterly Subscription", billingMonths: 3 }),
    ).toBe(30_00);
    expect(
      cyclePriceCents({
        platform: "skio",
        planName: "Annual Payment, Quarterly Delivery",
        billingMonths: 12,
      }),
    ).toBe(100_00);
  });

  it("falls back to the cadence for a nameless Skio plan", () => {
    // Same rule the renewal forecast uses, so the two views cannot disagree about the 46
    // subscriptions Skio hands over with no plan name.
    expect(cyclePriceCents({ platform: "skio", planName: null, billingMonths: 12 })).toBe(100_00);
  });

  it("parses the price Stripe states in its nickname", () => {
    expect(
      cyclePriceCents({ platform: "stripe", planName: "$30/quarter", billingMonths: 3 }),
    ).toBe(30_00);
    expect(cyclePriceCents({ platform: "stripe", planName: "$100/year", billingMonths: 12 })).toBe(
      100_00,
    );
    // The legacy annual prices, which is why cadence and price are separate concepts here.
    expect(cyclePriceCents({ platform: "stripe", planName: "$50 a year", billingMonths: 12 })).toBe(
      50_00,
    );
    expect(cyclePriceCents({ platform: "stripe", planName: "$80 a year", billingMonths: 12 })).toBe(
      80_00,
    );
  });

  it("handles a thousands separator and decimals", () => {
    expect(cyclePriceCents({ platform: "stripe", planName: "$1,250.50/yr", billingMonths: 12 }))
      .toBe(125_050);
  });

  it("returns null for a Stripe nickname carrying no price", () => {
    // A nickname is a label, not data. Guessing from it would put a made-up number into a
    // revenue figure.
    expect(cyclePriceCents({ platform: "stripe", planName: "Founder tier", billingMonths: 12 }))
      .toBeNull();
    expect(cyclePriceCents({ platform: "stripe", planName: null, billingMonths: 12 })).toBeNull();
  });
});

describe("groupByCadence", () => {
  it("merges the two platforms' names into one cadence", () => {
    // The whole point: "Quarterly Subscription" and "$30/quarter" are the same product.
    const groups = groupByCadence([
      row({ platform: "skio", planName: "Quarterly Subscription", subscriptions: 915 }),
      row({ platform: "stripe", planName: "$30/quarter", subscriptions: 154, mrrCents: 1000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cadence).toBe("quarterly");
    expect(groups[0].live).toBe(1069);
    expect(groups[0].byPlatform.map((p) => p.platform)).toEqual(["skio", "stripe"]);
  });

  it("counts only live subscriptions in the live total", () => {
    const groups = groupByCadence([
      row({ subscriptions: 915, status: "active" }),
      row({ subscriptions: 833, status: "canceled" }),
      row({ subscriptions: 404, status: null }),
    ]);
    expect(groups[0].live).toBe(915);
    expect(groups[0].total).toBe(2152);
  });

  it("annualises so cadences can be compared, and keeps the cycle figure separate", () => {
    // A quarterly cycle is three months and an annual cycle is a year, so the raw cycle
    // figures are not comparable — summing them would be meaningless. 100 quarterly subs at
    // $30 collect $3,000 per cycle and $12,000 a year.
    const [q] = groupByCadence([
      row({ subscriptions: 100, planName: "Quarterly Subscription", billingMonths: 3 }),
    ]);
    expect(q.cycleRevenueCents).toBe(3_000_00);
    expect(q.annualisedCents).toBe(12_000_00);

    const [a] = groupByCadence([
      row({
        cadence: "annual",
        planName: "Annual Payment, Quarterly Delivery",
        billingMonths: 12,
        subscriptions: 100,
      }),
    ]);
    // An annual cycle already IS a year, so the two are equal.
    expect(a.cycleRevenueCents).toBe(10_000_00);
    expect(a.annualisedCents).toBe(10_000_00);
  });

  it("counts unpriced live subscriptions instead of treating them as zero", () => {
    // Zero would sum silently into the revenue figure and understate it with no sign.
    const [g] = groupByCadence([
      row({ platform: "stripe", planName: "Founder tier", subscriptions: 5 }),
      row({ platform: "stripe", planName: "$30/quarter", subscriptions: 10 }),
    ]);
    expect(g.unpricedLive).toBe(5);
    expect(g.cycleRevenueCents).toBe(300_00);
  });

  it("keeps each price point visible rather than averaging the annual book", () => {
    // Stripe's annual subscribers sit on three prices. An average would report a plan that
    // nobody is on.
    const [g] = groupByCadence([
      row({ cadence: "annual", platform: "stripe", planName: "$100/year", billingMonths: 12, subscriptions: 66 }),
      row({ cadence: "annual", platform: "stripe", planName: "$50 a year", billingMonths: 12, subscriptions: 5 }),
      row({ cadence: "annual", platform: "stripe", planName: "$80 a year", billingMonths: 12, subscriptions: 1 }),
    ]);
    expect(g.plans.map((p) => p.priceCents)).toEqual([100_00, 50_00, 80_00]);
    expect(g.cycleRevenueCents).toBe(66 * 100_00 + 5 * 50_00 + 1 * 80_00);
  });

  it("orders quarterly first, then annual, whatever order the rows arrive in", () => {
    const groups = groupByCadence([
      row({ cadence: "other", billingMonths: 6, planName: null }),
      row({ cadence: "annual", billingMonths: 12 }),
      row({ cadence: "monthly", billingMonths: 1 }),
      row({ cadence: "quarterly", billingMonths: 3 }),
    ]);
    expect(groups.map((g) => g.cadence)).toEqual(["quarterly", "annual", "monthly", "other"]);
  });

  it("annualises an `other` cadence from the row's own interval", () => {
    // `other` can hold mixed intervals, so using the group's cadence would misprice them.
    const [g] = groupByCadence([
      row({ cadence: "other", platform: "stripe", planName: "$60 each", billingMonths: 6, subscriptions: 10 }),
    ]);
    expect(g.cycleRevenueCents).toBe(600_00);
    // Two six-month cycles a year.
    expect(g.annualisedCents).toBe(1_200_00);
  });

  it("returns nothing for no rows", () => {
    expect(groupByCadence([])).toEqual([]);
  });
});

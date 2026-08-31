import { describe, expect, it } from "vitest";
import {
  cancelledBeforeRenewal,
  cohortChurn,
  countable,
  renewalsCompleted,
  type SubscriptionRenewalInput,
} from "../src/metrics/renewal-counting";

const sub = (over: Partial<SubscriptionRenewalInput> = {}): SubscriptionRenewalInput => ({
  paidCharges: 1,
  cancelled: false,
  hasLinkedOrders: true,
  ...over,
});

describe("renewalsCompleted", () => {
  it("treats the first charge as the signup, not a renewal", () => {
    expect(renewalsCompleted(1)).toBe(0);
    expect(renewalsCompleted(2)).toBe(1);
    expect(renewalsCompleted(4)).toBe(3);
  });

  it("never goes negative on a subscription with no charges", () => {
    // Free-quarter signups have no PAID charge at all, and a negative renewal count would
    // propagate into the buckets as an index nobody handles.
    expect(renewalsCompleted(0)).toBe(0);
  });
});

describe("cancelledBeforeRenewal", () => {
  it("returns 1 for someone who cancelled without ever renewing", () => {
    // The figure Sam's sheet calls "cancels before first renewal": 319 in the Mar–Apr cohort
    // against 320 from this model.
    expect(cancelledBeforeRenewal(sub({ cancelled: true, paidCharges: 1 }))).toBe(1);
    expect(cancelledBeforeRenewal(sub({ cancelled: true, paidCharges: 0 }))).toBe(1);
  });

  it("returns 2 after exactly one renewal", () => {
    expect(cancelledBeforeRenewal(sub({ cancelled: true, paidCharges: 2 }))).toBe(2);
  });

  it("returns null for a live subscription", () => {
    // Null rather than 0, so a survivor cannot be confused with an immediate churn.
    expect(cancelledBeforeRenewal(sub({ cancelled: false, paidCharges: 3 }))).toBeNull();
  });
});

describe("countable", () => {
  it("excludes a subscription with no linked orders", () => {
    // 22% of the book — mostly Craft/Stripe migrants whose charges are on the other platform.
    // Counting them would report them as never-renewed, which is a missing link pretending to
    // be a cancellation.
    expect(countable(sub({ hasLinkedOrders: false }))).toBe(false);
    expect(countable(sub({ hasLinkedOrders: true }))).toBe(true);
  });
});

describe("cohortChurn", () => {
  it("buckets a cohort by how far it got", () => {
    const c = cohortChurn([
      sub({ cancelled: true, paidCharges: 1 }),
      sub({ cancelled: true, paidCharges: 1 }),
      sub({ cancelled: true, paidCharges: 2 }),
      sub({ cancelled: true, paidCharges: 4 }),
      sub({ cancelled: false, paidCharges: 3 }),
    ]);
    expect(c.churnedBeforeFirstRenewal).toBe(2);
    expect(c.churnedAfterFirst).toBe(1);
    expect(c.churnedLater).toBe(1);
    expect(c.stillLive).toBe(1);
    expect(c.measured).toBe(5);
    expect(c.firstRenewalChurnRate).toBeCloseTo(0.4);
  });

  it("divides by measured, not by the whole cohort", () => {
    // THE rule. Two unmeasurable subscriptions must not dilute the rate — they have not
    // declined to renew, they simply cannot be read.
    const c = cohortChurn([
      sub({ cancelled: true, paidCharges: 1 }),
      sub({ cancelled: false, paidCharges: 2 }),
      sub({ hasLinkedOrders: false }),
      sub({ hasLinkedOrders: false }),
    ]);
    expect(c.unmeasurable).toBe(2);
    expect(c.measured).toBe(2);
    expect(c.firstRenewalChurnRate).toBeCloseTo(0.5);
  });

  it("returns null rather than 0 when nothing is measurable", () => {
    const c = cohortChurn([sub({ hasLinkedOrders: false })]);
    expect(c.measured).toBe(0);
    expect(c.firstRenewalChurnRate).toBeNull();
  });

  it("handles an empty cohort", () => {
    const c = cohortChurn([]);
    expect(c.measured).toBe(0);
    expect(c.firstRenewalChurnRate).toBeNull();
  });
});

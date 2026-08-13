import { describe, expect, it } from "vitest";
import {
  classify,
  FREE_SHARE_THRESHOLD,
  MIN_ORDERS_TO_JUDGE,
  REVIEW_THRESHOLD,
  WATCH_THRESHOLD,
} from "../src/metrics/discounts";

/**
 * The ordering inside `classify` is the whole design, so these tests pin the order rather
 * than just the outcomes. Each rule exists because the obvious classification is wrong in a
 * specific, expensive way.
 */
describe("classify", () => {
  it("refuses to judge a code with too few orders, whatever its margin looks like", () => {
    // A code six orders deep can show any margin at all. Ranking it would put noise at the
    // top of a table whose entire purpose is deciding what to switch off.
    const r = classify({ orders: MIN_ORDERS_TO_JUDGE - 1, freeShare: 0, vsBaselineShare: -0.9 });
    expect(r.verdict).toBe("too-few");
    expect(r.note).toContain("noise");
  });

  it("calls a giveaway acquisition, not a margin failure", () => {
    // This is the /creatives ROAS trap in another costume: a free-issue offer has terrible
    // margin BY DESIGN, and a table that ranks it worst invites switching off a working
    // subscriber funnel.
    const r = classify({ orders: 500, freeShare: FREE_SHARE_THRESHOLD, vsBaselineShare: -3 });
    expect(r.verdict).toBe("acquisition");
    expect(r.note).toContain("giveaway");
  });

  it("checks volume BEFORE the giveaway rule", () => {
    // Otherwise a code with four free orders gets a confident "this is your acquisition
    // engine" verdict off four data points.
    const r = classify({ orders: 4, freeShare: 1, vsBaselineShare: -2 });
    expect(r.verdict).toBe("too-few");
  });

  it("grades against baseline once there is enough volume", () => {
    expect(classify({ orders: 100, freeShare: 0, vsBaselineShare: 0.2 }).verdict).toBe("healthy");
    expect(classify({ orders: 100, freeShare: 0, vsBaselineShare: -0.05 }).verdict).toBe("healthy");
    expect(
      classify({ orders: 100, freeShare: 0, vsBaselineShare: -(WATCH_THRESHOLD + 0.01) }).verdict,
    ).toBe("watch");
    expect(
      classify({ orders: 100, freeShare: 0, vsBaselineShare: -(REVIEW_THRESHOLD + 0.01) }).verdict,
    ).toBe("review");
  });

  it("never tells you to cut a code without mentioning who used it", () => {
    // A welcome code compared against a baseline full of repeat buyers measures "first order
    // vs any order". The verdict must not read as a clean instruction to kill it.
    const r = classify({ orders: 100, freeShare: 0, vsBaselineShare: -0.5 });
    expect(r.verdict).toBe("review");
    expect(r.note.toLowerCase()).toContain("new");
  });

  it("falls back to watch rather than a verdict when there is no baseline", () => {
    const r = classify({ orders: 100, freeShare: 0, vsBaselineShare: null });
    expect(r.verdict).toBe("watch");
    expect(r.note).toContain("No baseline");
  });
});

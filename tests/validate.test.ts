import { describe, expect, it } from "vitest";
import { CHECK_NAMES } from "../src/lib/validate/checks";

/**
 * The checks themselves need a database, so they are exercised by `run.cmd validate` against
 * live data rather than here. What CAN be pinned without one is the registry: that it hasn't
 * silently shrunk, and that every check is distinguishable in a report.
 *
 * Worth pinning because the failure mode is quiet. A check deleted or renamed during a refactor
 * takes its invariant with it, the report still says "all passed", and nothing anywhere reports
 * that there is now less being checked.
 */
describe("validation registry", () => {
  it("still covers every invariant class that has actually broken", () => {
    // One entry per real past failure. Adding a check is fine; losing one should fail here.
    const expected = [
      /order_profit covers/, // stale materialised table under-reported /international
      /revenue_class partitions/, // the CASE existed in two files
      /daily_metrics revenue agrees/, // rollup vs source drift
      /channel rows stay within the blended row/, // an unfiltered sum reads spend at ~2×
      /double-counted/, // Meta conversions counted ~3×
      /negative or absurd/, // a restated negative day flatters MER
      /attributed revenue does not exceed/, // attribution splits a total, cannot create one
      /duplicated shipping charge/, // rolling-window invoice ref re-recorded labels nightly
      /shipping invoices are fully allocated/, // cost reaching no order overstates margin
      /prepaid plan has a confirmed renewal price/, // annual plan priced 3.8× low
      /Instagram follower day/, // spliced insight chains invented a +150 day
      /content_metrics never exceeds/, // two GA4 queries over mismatched windows
      /both Shopify and Stripe revenue/, // fulfilment orders double-counting
      /silently stopped/, // Shopify's cursor froze for two weeks
    ];

    for (const pattern of expected) {
      expect(
        CHECK_NAMES.some((n) => pattern.test(n)),
        `no check matches ${pattern} — an invariant may have been dropped`,
      ).toBe(true);
    }
  });

  it("gives every check a distinct name", () => {
    // Names are the only handle on a result in the report and on the page. Two checks sharing
    // one would make a failure impossible to trace back to what failed.
    expect(new Set(CHECK_NAMES).size).toBe(CHECK_NAMES.length);
  });

  it("has no empty names", () => {
    for (const n of CHECK_NAMES) expect(n.trim().length).toBeGreaterThan(0);
  });
});

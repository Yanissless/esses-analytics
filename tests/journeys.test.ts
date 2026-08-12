import { describe, expect, it } from "vitest";
import {
  bucketLatencyHours,
  bucketTouches,
  LATENCY_BUCKETS,
  TOUCH_BUCKETS,
} from "../src/attribution/journeys";

/**
 * Journey bucketing.
 *
 * The boundaries matter more than they look. "Average path length 1.37" hid the fact that
 * the modal journey is a single touch and 71% of orders have none at all — so the bucket
 * that separates 1 from 2-3 is the one carrying the finding, and the `0` bucket has to be
 * its own category rather than folded in with 1.
 */

describe("bucketTouches", () => {
  it("keeps zero as its own bucket", () => {
    // Folding 0 in with 1 would erase the whole point: an order with no touchpoint is
    // unattributable, not attributable-to-one-channel.
    expect(bucketTouches(0)).toBe("0");
    expect(bucketTouches(1)).toBe("1");
  });

  it("splits single-touch from multi-touch at exactly 2", () => {
    expect(bucketTouches(1)).toBe("1");
    expect(bucketTouches(2)).toBe("2-3");
    expect(bucketTouches(3)).toBe("2-3");
    expect(bucketTouches(4)).toBe("4+");
  });

  it("puts long journeys in the top bucket", () => {
    expect(bucketTouches(12)).toBe("4+");
    expect(bucketTouches(500)).toBe("4+");
  });

  it("treats a negative count as zero rather than throwing", () => {
    expect(bucketTouches(-1)).toBe("0");
  });

  it("declares every bucket it can return", () => {
    for (const n of [0, 1, 2, 3, 4, 99]) {
      expect(TOUCH_BUCKETS).toContain(bucketTouches(n));
    }
  });
});

describe("bucketLatencyHours", () => {
  it("calls anything inside 24h same day", () => {
    expect(bucketLatencyHours(0)).toBe("same day");
    expect(bucketLatencyHours(23.9)).toBe("same day");
  });

  it("puts exactly 24h into 1-3 days, not same day", () => {
    // The boundary is closed on the upper bucket: 24h is a day later, not the same day.
    expect(bucketLatencyHours(24)).toBe("1-3 days");
  });

  it("uses inclusive upper bounds on each day band", () => {
    expect(bucketLatencyHours(72)).toBe("1-3 days"); // exactly 3 days
    expect(bucketLatencyHours(73)).toBe("4-7 days");
    expect(bucketLatencyHours(168)).toBe("4-7 days"); // exactly 7 days
    expect(bucketLatencyHours(169)).toBe("8-30 days");
    expect(bucketLatencyHours(720)).toBe("8-30 days"); // exactly 30 days
    expect(bucketLatencyHours(721)).toBe("30+ days");
  });

  it("clamps a negative latency to same day instead of dropping it", () => {
    // A touch stamped marginally after its order is clock skew between our session capture
    // and Shopify's processed_at. Dropping those rows would bias the distribution toward
    // longer journeys; calling them same-day is the honest reading.
    expect(bucketLatencyHours(-0.5)).toBe("same day");
    expect(bucketLatencyHours(-100)).toBe("same day");
  });

  it("declares every bucket it can return", () => {
    for (const h of [-1, 0, 24, 100, 200, 1000]) {
      expect(LATENCY_BUCKETS).toContain(bucketLatencyHours(h));
    }
  });
});

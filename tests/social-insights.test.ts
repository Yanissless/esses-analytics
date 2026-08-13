import { describe, expect, it } from "vitest";
import {
  SOCIAL_PLATFORM_METRICS_GAP,
  SOCIAL_PLATFORM_METRICS_HAVE,
} from "../src/metrics/social";

/**
 * The gap list and the have list are shown side by side on `/social`, and the whole point of
 * pairing them is that a reader can trust "we have this" and "we don't have this" to be
 * mutually exclusive. A metric drifting into both is the failure this catches — most likely
 * when a connector lands and only one of the two lists gets updated.
 */
describe("social platform metric coverage lists", () => {
  it("never claims the same thing is both covered and missing", () => {
    const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").trim();
    const have = SOCIAL_PLATFORM_METRICS_HAVE.map(norm);
    const gap = SOCIAL_PLATFORM_METRICS_GAP.map(norm);
    const both = have.filter((h) => gap.includes(h));
    expect(both).toEqual([]);
  });

  it("still lists per-post granularity as missing", () => {
    // Account-level reach arrived on 13 Aug 2026; per-post did not, and conflating the two
    // would have the page claim it can tell you which creative earned the reach. It can't.
    const gap = SOCIAL_PLATFORM_METRICS_GAP.join(" ").toLowerCase();
    expect(gap).toContain("per-post");
  });
});

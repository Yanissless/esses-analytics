import { describe, expect, it } from "vitest";
import { staleSummary } from "../src/lib/freshness.server";
import type { SourceFreshness } from "../src/lib/freshness.server";

const src = (source: string, ageHours: number | null): SourceFreshness => ({
  source,
  ageHours,
  lastRunAt: ageHours === null ? null : "2026-08-20T16:26:31Z",
  lastStatus: "success",
  stale: true,
  warnings: [],
  lastDataDate: null,
  lastDayProvisional: false,
});

/**
 * The multi-source wording is only reachable while two sources are behind at once, which is
 * the state a working auto-refresh removes — so it cannot practically be checked in a browser.
 * That is the whole reason it is a pure function.
 */
describe("staleSummary", () => {
  it("names one source plainly", () => {
    expect(staleSummary([src("shopify", 27)])).toBe("shopify last synced 27h ago.");
  });

  it("states the explanation once for several sources, not once each", () => {
    // The bug this replaced: with Meta and Shopify both 27h behind, the banner rendered the
    // whole sentence — reason and remedy included — twice, and read like a rendering fault.
    const s = staleSummary([src("meta", 27), src("shopify", 27)]);
    expect(s).toBe("2 sources are behind — meta 27h, shopify 27h.");
    // The reason and remedy live in the banner, appearing exactly once regardless of count.
    expect(s).not.toContain("flagged");
    expect(s).not.toContain("run.cmd");
  });

  it("puts the oldest source first", () => {
    // If only the first name gets read, it should be the one most worth knowing about.
    expect(staleSummary([src("meta", 27), src("skio", 90), src("stripe", 40)])).toBe(
      "3 sources are behind — skio 90h, stripe 40h, meta 27h.",
    );
  });

  it("treats never-synced as the worst case, not as zero hours", () => {
    // A null age sorted as 0 would rank a source that has NEVER run as the freshest thing on
    // the list, which is precisely backwards.
    expect(staleSummary([src("meta", 27), src("ga4", null)])).toBe(
      "2 sources are behind — ga4 never synced, meta 27h.",
    );
  });

  it("says 'has never synced' rather than 'synced never ago' for a single source", () => {
    expect(staleSummary([src("ga4", null)])).toBe("ga4 has never synced.");
  });

  it("returns nothing when nothing is stale", () => {
    // The banner renders no element at all in this case; an empty string keeps that decision
    // in one place rather than two.
    expect(staleSummary([])).toBe("");
  });

  it("rounds rather than printing a fractional hour", () => {
    expect(staleSummary([src("shopify", 26.7)])).toBe("shopify last synced 27h ago.");
  });
});

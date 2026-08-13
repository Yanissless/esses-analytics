import { describe, expect, it } from "vitest";
import {
  addDays,
  comparisonFor,
  daysInclusive,
  delta,
  formatRange,
  isGood,
  isIsoDate,
  isRangePreset,
  RANGE_PRESETS,
  resolveRange,
  shiftYear,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  type RangePreset,
} from "../src/lib/date-range";

/**
 * Date ranges and period comparison.
 *
 * Two things here are load-bearing and both are easy to get subtly wrong:
 *
 *  1. Presets end at the last day with DATA, not today. The metrics tables lag the sync, so
 *     a range running to "now" includes days that are empty because nothing was ingested
 *     yet. Those are unknown days, not zero-revenue days, and averaging them in makes a
 *     healthy week read as a collapse.
 *  2. The comparison window is the preceding window of EQUAL LENGTH, never the previous
 *     calendar unit. On the 12th, month-to-date is 12 days; comparing it against a full
 *     31-day month invents a ~60% decline out of nothing.
 */

// Anchor and data start taken from the live database, so the fixtures match reality.
const ANCHOR = "2026-08-12";
const DATA_START = "2025-10-01";
const opts = { anchor: ANCHOR, dataStart: DATA_START };

describe("day arithmetic is UTC and inclusive", () => {
  it("adds and subtracts days across month and year boundaries", () => {
    expect(addDays("2026-08-12", 1)).toBe("2026-08-13");
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap year
  });

  it("counts a single day as one, not zero", () => {
    // Off-by-one here makes every preset a day short.
    expect(daysInclusive("2026-08-12", "2026-08-12")).toBe(1);
    expect(daysInclusive("2026-08-06", "2026-08-12")).toBe(7);
  });

  it("finds period starts", () => {
    expect(startOfMonth("2026-08-12")).toBe("2026-08-01");
    expect(startOfYear("2026-08-12")).toBe("2026-01-01");
    // Q3 begins in July.
    expect(startOfQuarter("2026-08-12")).toBe("2026-07-01");
    expect(startOfQuarter("2026-01-15")).toBe("2026-01-01");
    expect(startOfQuarter("2026-06-30")).toBe("2026-04-01");
    expect(startOfQuarter("2026-12-31")).toBe("2026-10-01");
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2026-08-12")).toBe(true);
    expect(isIsoDate("2026-8-12")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(20260812)).toBe(false);
  });
});

describe("presets end at the last day with data, never today", () => {
  it("ends every preset on the anchor", () => {
    for (const p of RANGE_PRESETS) {
      expect(resolveRange(p.id, opts).until, p.id).toBe(ANCHOR);
    }
  });

  it("counts back inclusively from the anchor", () => {
    // 7 days ending 12 Aug is 6–12 Aug, not 5–12.
    const r = resolveRange("7d", opts);
    expect(r.since).toBe("2026-08-06");
    expect(r.days).toBe(7);

    expect(resolveRange("28d", opts).since).toBe("2026-07-16");
    expect(resolveRange("28d", opts).days).toBe(28);
  });

  it("resolves calendar-anchored presets", () => {
    expect(resolveRange("mtd", opts).since).toBe("2026-08-01");
    expect(resolveRange("qtd", opts).since).toBe("2026-07-01");
    expect(resolveRange("ytd", opts).since).toBe("2026-01-01");
  });

  it("clips to the data start and says so", () => {
    // Only ~10 months of data exist, so a 12-month view is really 10 months. Flagging it
    // stops the missing two months being read as a decline.
    const r = resolveRange("12m", opts);
    expect(r.since).toBe(DATA_START);
    expect(r.clippedToDataStart).toBe(true);

    expect(resolveRange("28d", opts).clippedToDataStart).toBe(false);
  });

  it("uses the whole dataset for all-time", () => {
    const r = resolveRange("all", opts);
    expect(r.since).toBe(DATA_START);
    expect(r.until).toBe(ANCHOR);
  });
});

describe("custom ranges degrade rather than throw", () => {
  it("honours a valid custom window", () => {
    const r = resolveRange("custom", { ...opts, since: "2026-03-01", until: "2026-03-31" });
    expect([r.since, r.until]).toEqual(["2026-03-01", "2026-03-31"]);
    expect(r.days).toBe(31);
  });

  it("falls back to a sane window when a URL carries nonsense", () => {
    // A bad query string should render a page, not a stack trace.
    const r = resolveRange("custom", { ...opts, since: "not-a-date", until: "also-bad" });
    expect(r.until).toBe(ANCHOR);
    expect(isIsoDate(r.since)).toBe(true);
  });

  it("treats a backwards range as a typo instead of returning a negative span", () => {
    const r = resolveRange("custom", { ...opts, since: "2026-08-12", until: "2026-08-01" });
    expect(r.days).toBeGreaterThan(0);
    expect(r.since <= r.until).toBe(true);
  });

  it("never starts before the data does", () => {
    const r = resolveRange("custom", { ...opts, since: "2020-01-01", until: ANCHOR });
    expect(r.since).toBe(DATA_START);
    expect(r.clippedToDataStart).toBe(true);
  });
});

describe("the comparison window matches the current one in LENGTH", () => {
  it("compares a partial month against the same number of days, not a full month", () => {
    // The bug this prevents: month-to-date on the 12th is 12 days. Against a full 31-day
    // July it would show a ~60% collapse that is purely an artefact of window length.
    const mtd = resolveRange("mtd", opts);
    expect(mtd.days).toBe(12);

    const cmp = comparisonFor("previous", mtd, DATA_START);
    expect(cmp).not.toBeNull();
    expect(daysInclusive(cmp!.since, cmp!.until)).toBe(12);
    // Immediately preceding, so it ends the day before the current window starts.
    expect(cmp!.until).toBe("2026-07-31");
    expect(cmp!.since).toBe("2026-07-20");
  });

  it("sits immediately before the current window with no gap or overlap", () => {
    const r = resolveRange("28d", opts);
    const cmp = comparisonFor("previous", r, DATA_START)!;
    expect(addDays(cmp.until, 1)).toBe(r.since);
    expect(daysInclusive(cmp.since, cmp.until)).toBe(r.days);
  });

  it("returns null when there is no prior data at all", () => {
    // All-time has nothing before it by definition.
    const all = resolveRange("all", opts);
    expect(comparisonFor("previous", all, DATA_START)).toBeNull();
  });

  it("flags a comparison that reaches back past the data start", () => {
    const r = resolveRange("custom", { ...opts, since: "2025-10-05", until: "2025-11-05" });
    const cmp = comparisonFor("previous", r, DATA_START);
    expect(cmp).not.toBeNull();
    expect(cmp!.partial).toBe(true);
  });

  it("returns nothing for compare mode none", () => {
    expect(comparisonFor("none", resolveRange("28d", opts), DATA_START)).toBeNull();
  });
});

describe("year-on-year is null when the data cannot support it", () => {
  it("refuses when the comparison window predates the data entirely", () => {
    // Orders begin 2025-10-01, so a year-on-year read of Aug 2026 needs Aug 2025 and there
    // is none. Null beats "revenue doubled" computed against nothing.
    const r = resolveRange("28d", opts);
    expect(comparisonFor("year", r, DATA_START)).toBeNull();
  });

  it("allows it once the prior year is covered", () => {
    const r = resolveRange("custom", { ...opts, since: "2026-11-01", until: "2026-11-30" });
    const cmp = comparisonFor("year", r, DATA_START);
    expect(cmp).not.toBeNull();
    expect([cmp!.since, cmp!.until]).toEqual(["2025-11-01", "2025-11-30"]);
  });

  it("shifts years without inventing 29 February", () => {
    expect(shiftYear("2024-02-29", 1)).toBe("2025-02-28");
    expect(shiftYear("2026-08-12", -1)).toBe("2025-08-12");
  });
});

describe("delta", () => {
  it("reports absolute and percentage change", () => {
    const d = delta(120, 100);
    expect(d.absolute).toBe(20);
    expect(d.pct).toBeCloseTo(0.2, 10);
    expect(d.direction).toBe("up");
  });

  it("handles decline and flat", () => {
    expect(delta(80, 100).direction).toBe("down");
    expect(delta(100, 100).direction).toBe("flat");
    expect(delta(100, 100).pct).toBe(0);
  });

  it("returns a null percentage when the previous value is zero", () => {
    // Rule 3. Growth from nothing has no percentage — not infinity, not 0%.
    const d = delta(50, 0);
    expect(d.pct).toBeNull();
    expect(d.absolute).toBe(50);
    // Direction still means something, which is why it is a separate field.
    expect(d.direction).toBe("up");
  });
});

describe("isGood knows that a rise is not always good news", () => {
  it("reads a rise as good for revenue-like metrics", () => {
    expect(isGood(delta(120, 100), "higher-is-better")).toBe(true);
    expect(isGood(delta(80, 100), "higher-is-better")).toBe(false);
  });

  it("reads a rise as bad for cost-like metrics", () => {
    // CAC going up is bad news. A UI that paints every increase green teaches people to
    // skim for colour and read CAC backwards.
    expect(isGood(delta(12, 8), "lower-is-better")).toBe(false);
    expect(isGood(delta(8, 12), "lower-is-better")).toBe(true);
  });

  it("is null when nothing changed", () => {
    expect(isGood(delta(100, 100), "higher-is-better")).toBeNull();
  });
});

describe("labels", () => {
  it("collapses shared month and year", () => {
    expect(formatRange("2026-08-06", "2026-08-12")).toBe("6–12 Aug 2026");
    expect(formatRange("2026-07-16", "2026-08-12")).toBe("16 Jul – 12 Aug 2026");
    expect(formatRange("2025-12-30", "2026-01-02")).toBe("30 Dec 2025 – 2 Jan 2026");
    expect(formatRange("2026-08-12", "2026-08-12")).toBe("12 Aug 2026");
  });

  it("names the preset in the range label", () => {
    expect(resolveRange("28d", opts).label).toContain("28 days");
    expect(resolveRange("ytd", opts).label).toContain("Year to date");
  });

  it("validates preset ids from a URL", () => {
    expect(isRangePreset("28d")).toBe(true);
    expect(isRangePreset("custom")).toBe(true);
    expect(isRangePreset("last-tuesday")).toBe(false);
    for (const p of RANGE_PRESETS) expect(isRangePreset(p.id as RangePreset)).toBe(true);
  });
});

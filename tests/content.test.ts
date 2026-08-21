import { describe, expect, it } from "vitest";
import {
  editorialShare,
  engagedShare,
  engagementPerSession,
  shareOfTraffic,
  unclassifiedShare,
  type ContentCoverage,
  type KindSplit,
} from "../src/metrics/content";

const coverage = (over: Partial<ContentCoverage> = {}): ContentCoverage => ({
  daysWithData: 28,
  daysInRange: 28,
  firstDay: "2026-07-25",
  lastDay: "2026-08-21",
  totalSessions: 10_000,
  totalViews: 14_000,
  itemisedSessions: 10_000,
  daysWithOtherRow: 0,
  hiddenSessions: 0,
  sampledDays: 0,
  provisionalDays: 2,
  ...over,
});

describe("engagement ratios", () => {
  it("computes seconds per session", () => {
    expect(engagementPerSession({ engagementSeconds: 3_000, sessions: 100 })).toBe(30);
  });

  it("returns null rather than zero when there are no sessions", () => {
    // A page with no readers has no average engagement time. Zero would sort it alongside a
    // page everyone bounced from, which is a completely different thing.
    expect(engagementPerSession({ engagementSeconds: 0, sessions: 0 })).toBeNull();
    expect(engagedShare({ engagedSessions: 0, sessions: 0 })).toBeNull();
  });

  it("computes engaged share", () => {
    expect(engagedShare({ engagedSessions: 40, sessions: 200 })).toBe(0.2);
  });
});

describe("shareOfTraffic", () => {
  it("divides by the day totals, not the itemised rows", () => {
    const r = shareOfTraffic(2_500, coverage());
    expect(r.share).toBe(0.25);
  });

  it("withholds the share when GA4 hid traffic in an (other) bucket", () => {
    // THE case. A share computed from itemised rows when GA4 stopped itemising is inflated by
    // an unknown factor — and it would be the most quotable number on the page.
    const r = shareOfTraffic(2_500, coverage({ daysWithOtherRow: 3, hiddenSessions: 4_000 }));
    expect(r.share).toBeNull();
    expect(r.reason).toContain("other");
    expect(r.reason).toContain("4,000");
  });

  it("withholds the share when there is no denominator at all", () => {
    const r = shareOfTraffic(100, coverage({ totalSessions: 0 }));
    expect(r.share).toBeNull();
    expect(r.reason).toContain("no day totals");
  });

  it("does not return Infinity or NaN on an empty range", () => {
    const r = shareOfTraffic(0, coverage({ totalSessions: 0, itemisedSessions: 0 }));
    expect(r.share).toBeNull();
  });
});

describe("composition shares", () => {
  const split: KindSplit[] = [
    { kind: "article", sessions: 4_000, views: 5_000, pages: 120 },
    { kind: "product", sessions: 3_000, views: 4_000, pages: 30 },
    { kind: "home", sessions: 1_000, views: 1_200, pages: 1 },
    { kind: "funnel", sessions: 1_500, views: 2_000, pages: 8 },
    { kind: "unclassified", sessions: 500, views: 600, pages: 40 },
  ];

  it("counts articles, static pages and home as editorial", () => {
    // 4,000 + 1,000 of 10,000.
    expect(editorialShare(split)).toBeCloseTo(0.5);
  });

  it("reports the unclassified share so a wrong classifier is visible", () => {
    // The honesty check. If this number is large the path patterns are wrong, and the fix is
    // to read the real paths — not to trust a classifier quietly folding them into "other".
    expect(unclassifiedShare(split)).toBeCloseTo(0.05);
  });

  it("returns null on an empty split rather than a zero share", () => {
    expect(editorialShare([])).toBeNull();
    expect(unclassifiedShare([])).toBeNull();
  });

  it("returns null when every bucket is empty", () => {
    // Guards a divide-by-zero that would otherwise surface as NaN in the UI.
    const empty: KindSplit[] = [{ kind: "article", sessions: 0, views: 0, pages: 0 }];
    expect(editorialShare(empty)).toBeNull();
    expect(unclassifiedShare(empty)).toBeNull();
  });

  it("divides by itemised sessions, NOT by the true day totals", () => {
    // Pins the denominator, which is the whole reason these two functions take a split rather
    // than a coverage. 4,000 + 1,000 editorial over a 10,000 itemised total is 50% — and stays
    // 50% however much traffic GA4 left out of the per-page rows. The page is required to label
    // it as a share of itemised sessions and to show the unallocated remainder, because the same
    // 50% against an unnamed denominator would be the most quotable and least defensible figure
    // on the page.
    expect(editorialShare(split)).toBeCloseTo(0.5);
    const itemised = split.reduce((a, s) => a + s.sessions, 0);
    expect(itemised).toBe(10_000);
  });

  it("reports zero unclassified when everything matched a pattern", () => {
    // Zero is a real answer here, distinct from null: it means the classifier covered the range.
    const clean: KindSplit[] = [{ kind: "article", sessions: 100, views: 120, pages: 5 }];
    expect(unclassifiedShare(clean)).toBe(0);
  });
});

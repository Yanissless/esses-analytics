import { describe, expect, it } from "vitest";
import {
  BOUNDARY_META,
  DEFAULT_MARGIN_BOUNDARY,
  MARGIN_BOUNDARIES,
  isMarginBoundary,
} from "../src/metrics/margin-boundary";

describe("margin boundary", () => {
  it("defaults to the least surprising option", () => {
    // paid_only matches each order's revenue to its own costs, which is what a
    // margin % is normally understood to mean.
    expect(DEFAULT_MARGIN_BOUNDARY).toBe("paid_only");
    expect(MARGIN_BOUNDARIES).toContain(DEFAULT_MARGIN_BOUNDARY);
  });

  it("describes every boundary, so the UI never shows a bare enum", () => {
    for (const b of MARGIN_BOUNDARIES) {
      const meta = BOUNDARY_META[b];
      expect(meta.id).toBe(b);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.short.length).toBeGreaterThan(0);
      // The explanation must state the trade-off, not just restate the label.
      expect(meta.explanation.length).toBeGreaterThan(80);
    }
  });

  it("orders the options from narrowest to widest cost inclusion", () => {
    // The settings form renders in this order, and the progression is the point:
    // each option charges strictly more cost than the one before it.
    expect(MARGIN_BOUNDARIES).toEqual(["paid_only", "exclude_comps", "all_classes"]);
  });

  /**
   * The value is persisted as free text in `margin_settings.margin_boundary`, so a
   * hand-edited or legacy row must not be able to produce an unhandled boundary.
   */
  it("validates untrusted values rather than trusting the column", () => {
    expect(isMarginBoundary("paid_only")).toBe(true);
    expect(isMarginBoundary("exclude_comps")).toBe(true);
    expect(isMarginBoundary("all_classes")).toBe(true);

    expect(isMarginBoundary("")).toBe(false);
    expect(isMarginBoundary("PAID_ONLY")).toBe(false);
    expect(isMarginBoundary("paid")).toBe(false);
    expect(isMarginBoundary(null)).toBe(false);
    expect(isMarginBoundary(undefined)).toBe(false);
    expect(isMarginBoundary(3)).toBe(false);
    expect(isMarginBoundary({ id: "paid_only" })).toBe(false);
  });
});

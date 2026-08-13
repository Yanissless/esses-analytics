import { describe, expect, it } from "vitest";
import {
  MIN_MONTHS_FOR_SEASONALITY,
  monthlyWeights,
  paceVariance,
  releaseWeights,
  splitAnnualTarget,
  targetProgress,
} from "../src/metrics/goal-planner";

/**
 * The whole reason this module exists is to refuse to manufacture a seasonal shape it cannot
 * support. These tests pin the refusal, because the failure mode is silent and flattering:
 * weighting on one incomplete year sets the LOWEST targets for the months that happened to be
 * quiet, so a genuinely bad month clears its target and nothing flags.
 */
describe("monthlyWeights", () => {
  it("refuses to weight seasonally on less than two years", () => {
    // 11 months, exactly the real situation as of Aug 2026.
    const history = Array.from({ length: 11 }, (_, i) => ({ month: i + 1, value: 1000 * (i + 1) }));
    const r = monthlyWeights(history);
    expect(r.method).toBe("flat");
    expect(r.weights.every((w) => Math.abs(w - 1 / 12) < 1e-12)).toBe(true);
    expect(r.reason).toContain(String(MIN_MONTHS_FOR_SEASONALITY));
  });

  it("weights by the AVERAGE per calendar month, not the sum", () => {
    // Two years, every month equal, except January which is observed twice as large.
    // Summing would make January look twice as seasonal purely for being observed twice.
    const history: Array<{ month: number; value: number }> = [];
    for (let y = 0; y < 2; y++) {
      for (let m = 1; m <= 12; m++) history.push({ month: m, value: m === 1 ? 200 : 100 });
    }
    const r = monthlyWeights(history);
    expect(r.method).toBe("seasonal");
    // January is genuinely 2x every other month, and 2/(2 + 11) of the total.
    expect(r.weights[0]).toBeCloseTo(200 / (200 + 1100), 10);
    expect(r.weights[1]).toBeCloseTo(100 / (200 + 1100), 10);
    expect(r.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("falls back to flat when a calendar month has no history at all", () => {
    // 24 observations but nothing in December — a full-year shape would have to invent it.
    const history: Array<{ month: number; value: number }> = [];
    for (let i = 0; i < 24; i++) history.push({ month: (i % 11) + 1, value: 100 });
    const r = monthlyWeights(history);
    expect(r.method).toBe("flat");
    expect(r.reason).toContain("no history");
  });
});

describe("releaseWeights", () => {
  it("puts more weight on release months without starving the rest", () => {
    // Four issues a year, March/June/September/December.
    const r = releaseWeights([3, 6, 9, 12], 0.35);
    expect(r.method).toBe("release");
    expect(r.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);

    const release = r.weights[2];
    const quiet = r.weights[0];
    expect(release).toBeGreaterThan(quiet);
    // A quiet month still carries its share of baseline renewals rather than a zero target.
    expect(quiet).toBeCloseTo(0.35 / 12, 10);
  });

  it("counts a month with two releases twice", () => {
    const r = releaseWeights([5, 5, 11], 0);
    expect(r.weights[4]).toBeCloseTo(2 / 3, 10);
    expect(r.weights[10]).toBeCloseTo(1 / 3, 10);
  });
});

describe("splitAnnualTarget", () => {
  it("makes the twelve months sum EXACTLY to the annual figure", () => {
    // 1,000,001 over flat weights doesn't divide evenly — the remainder has to land somewhere
    // rather than leaving the year's targets short of the year's target.
    const months = splitAnnualTarget(1_000_001, 2026, new Array(12).fill(1 / 12));
    expect(months).toHaveLength(12);
    expect(months.reduce((a, m) => a + m.target, 0)).toBe(1_000_001);
    expect(months[0].periodStart).toBe("2026-01-01");
    expect(months[11].periodStart).toBe("2026-12-01");
  });

  it("survives lumpy weights and still reconciles", () => {
    const w = releaseWeights([3, 6, 9, 12], 0.35).weights;
    const months = splitAnnualTarget(987_654, 2026, w);
    expect(months.reduce((a, m) => a + m.target, 0)).toBe(987_654);
  });
});

describe("targetProgress and paceVariance", () => {
  it("returns null for no target rather than 0%", () => {
    // "No target set" and "0% of target" are different statements; a badge rendering the
    // second when it means the first is a fabricated red light.
    expect(targetProgress(500, null)).toBeNull();
    expect(targetProgress(500, 0)).toBeNull();
    expect(targetProgress(500, 1000)).toBeCloseTo(0.5, 10);
  });

  it("pro-rates the target by elapsed time", () => {
    // Half the month gone, half the target hit: exactly on pace, not 50% behind.
    expect(paceVariance(500, 1000, 15, 30)).toBeCloseTo(0, 10);
    // Two-thirds of the target with half the month gone is 33% ahead.
    expect(paceVariance(666.67, 1000, 15, 30)).toBeCloseTo(0.33334, 4);
  });

  it("returns null before any of the period has elapsed", () => {
    // On day zero everything is infinitely behind, which is noise rather than news.
    expect(paceVariance(0, 1000, 0, 30)).toBeNull();
  });
});

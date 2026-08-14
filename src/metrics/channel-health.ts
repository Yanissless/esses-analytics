/**
 * Channel health — the red/amber/green treatment, graded honestly.
 *
 * StoreHero shows "Google Ads ● Healthy / Facebook Ads ● At risk" with a per-metric year-on-year
 * column. This is the same idea with two deliberate differences, both forced by the data:
 *
 * ## 1. Period-over-period, not year-on-year
 *
 * `daily_metrics` starts 2025-10-01. A "last 28 days" window ending Aug 2026 compares to
 * Jul-Aug 2025, where there is nothing. YoY columns would be empty for every range anyone
 * actually looks at until Oct 2026, and an empty column that fills in silently later is worse
 * than no column — nobody notices the day it starts meaning something.
 *
 * So the comparison is the preceding period of equal length, which is available today. When
 * there are two full years this should gain a YoY mode; `basis` exists so the page can say
 * which it used rather than leaving the reader to assume.
 *
 * ## 2. A channel is not graded until it has enough volume
 *
 * A channel with four conversions can swing 300% between periods on noise. Grading that
 * produces a confident red light on nothing, and red lights that turn out to be noise are how
 * people learn to ignore red lights. Below `MIN_CONVERSIONS_TO_GRADE` the status is
 * `insufficient` and the reason says so.
 *
 * ## Polarity is declared per metric
 *
 * ROAS rising is good; CAC rising is not. A comparison UI that paints every increase green
 * teaches people to read CAC backwards — the same rule the stat tiles follow.
 */

import { ratio } from "./formulas";

/** Below this many conversions in the current period, a channel is reported but not graded. */
export const MIN_CONVERSIONS_TO_GRADE = 15;

/** Movement smaller than this is noise, not a trend. */
export const FLAT_BAND = 0.05;
/** Beyond this in the wrong direction is a problem rather than a wobble. */
export const AT_RISK_BAND = 0.2;

export type HealthStatus = "healthy" | "watch" | "at-risk" | "insufficient";

export type MetricPolarity = "higher-is-better" | "lower-is-better";

export interface MetricComparison {
  key: string;
  label: string;
  current: number | null;
  previous: number | null;
  /** Fractional change. Null when previous is zero or either side is missing. */
  change: number | null;
  polarity: MetricPolarity;
  status: HealthStatus;
}

export interface ChannelHealth {
  channel: string;
  conversions: number;
  spendCents: number;
  revenueCents: number;
  metrics: MetricComparison[];
  /** Worst status across gradeable metrics. */
  status: HealthStatus;
  /** Why that status, in one sentence. Always populated. */
  reason: string;
  /** What the comparison is against, so the page never has to guess. */
  basis: "previous-period";
}

/**
 * Fractional change, or null when it cannot be stated.
 *
 * Null rather than 0 when the previous value is 0: going from nothing to something is not a
 * percentage increase, it is a new thing. Reporting it as +∞ or +100% both mislead.
 */
export function changeFrom(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Grades one metric, respecting its polarity. */
export function gradeMetric(
  change: number | null,
  polarity: MetricPolarity,
  gradeable: boolean,
): HealthStatus {
  if (!gradeable) return "insufficient";
  if (change === null) return "insufficient";
  if (Math.abs(change) < FLAT_BAND) return "healthy";

  // Translate the movement into "good" or "bad" before comparing to the bands, so one set of
  // thresholds serves both polarities and CAC cannot be read backwards.
  const good = polarity === "higher-is-better" ? change > 0 : change < 0;
  if (good) return "healthy";
  return Math.abs(change) >= AT_RISK_BAND ? "at-risk" : "watch";
}

const STATUS_RANK: Record<HealthStatus, number> = {
  "at-risk": 0,
  watch: 1,
  healthy: 2,
  insufficient: 3,
};

export interface ChannelPeriod {
  channel: string;
  attributedRevenueCents: number;
  attributedConversions: number;
  spendCents: number;
  roas: number | null;
  cac: number | null;
}

/**
 * Builds a health card for one channel from its current and previous period.
 *
 * `previous` may be null — a channel that did not exist last period is new, not collapsing,
 * and every change is therefore null rather than -100%.
 */
export function buildChannelHealth(
  current: ChannelPeriod,
  previous: ChannelPeriod | null,
): ChannelHealth {
  const gradeable = current.attributedConversions >= MIN_CONVERSIONS_TO_GRADE;

  const defs: Array<{
    key: string;
    label: string;
    cur: number | null;
    prev: number | null;
    polarity: MetricPolarity;
  }> = [
    {
      key: "roas",
      label: "ROAS",
      cur: current.roas,
      prev: previous?.roas ?? null,
      polarity: "higher-is-better",
    },
    {
      key: "cac",
      label: "CAC",
      cur: current.cac,
      prev: previous?.cac ?? null,
      polarity: "lower-is-better",
    },
    {
      key: "revenue",
      label: "Revenue",
      cur: current.attributedRevenueCents,
      prev: previous?.attributedRevenueCents ?? null,
      polarity: "higher-is-better",
    },
    {
      key: "conversions",
      label: "Conversions",
      cur: current.attributedConversions,
      prev: previous?.attributedConversions ?? null,
      polarity: "higher-is-better",
    },
    {
      key: "spend",
      label: "Spend",
      cur: current.spendCents,
      prev: previous?.spendCents ?? null,
      // Spend is NOT graded: spending more is neither good nor bad on its own, it is the
      // input whose efficiency the other metrics measure. Shown for context only.
      polarity: "higher-is-better",
    },
  ];

  const metrics: MetricComparison[] = defs.map((d) => {
    const change = changeFrom(d.cur, d.prev);
    return {
      key: d.key,
      label: d.label,
      current: d.cur,
      previous: d.prev,
      change,
      polarity: d.polarity,
      status: d.key === "spend" ? "insufficient" : gradeMetric(change, d.polarity, gradeable),
    };
  });

  const graded = metrics.filter((m) => m.key !== "spend" && m.status !== "insufficient");
  const worst = graded.reduce<HealthStatus>(
    (acc, m) => (STATUS_RANK[m.status] < STATUS_RANK[acc] ? m.status : acc),
    "healthy",
  );

  const status: HealthStatus = graded.length === 0 ? "insufficient" : worst;

  let reason: string;
  if (!gradeable) {
    reason = `${current.attributedConversions} attributed conversion(s) — below ${MIN_CONVERSIONS_TO_GRADE}, so period-on-period movement here is noise rather than trend.`;
  } else if (graded.length === 0) {
    reason = "No prior period to compare against, so nothing can be graded yet.";
  } else if (status === "healthy") {
    reason = "Every graded metric is flat or improving against the previous period.";
  } else {
    const bad = graded
      .filter((m) => m.status === status)
      .map((m) => `${m.label} ${m.change === null ? "" : formatSigned(m.change)}`.trim())
      .join(", ");
    reason =
      status === "at-risk"
        ? `Moved against you by more than ${Math.round(AT_RISK_BAND * 100)}%: ${bad}.`
        : `Slipping but within ${Math.round(AT_RISK_BAND * 100)}%: ${bad}.`;
  }

  return {
    channel: current.channel,
    conversions: current.attributedConversions,
    spendCents: current.spendCents,
    revenueCents: current.attributedRevenueCents,
    metrics,
    status,
    reason,
    basis: "previous-period",
  };
}

function formatSigned(v: number): string {
  const pct = Math.round(Math.abs(v) * 100);
  return `${v >= 0 ? "+" : "−"}${pct}%`;
}

/**
 * Health for every channel, worst first.
 *
 * Channels present in the previous period but absent now are dropped rather than shown at
 * -100%: "we stopped running it" and "it collapsed" look identical in the numbers, and this
 * module cannot tell them apart.
 */
export function buildChannelHealthList(
  current: ChannelPeriod[],
  previous: ChannelPeriod[],
): ChannelHealth[] {
  const prevByChannel = new Map(previous.map((p) => [p.channel, p]));
  return current
    .map((c) => buildChannelHealth(c, prevByChannel.get(c.channel) ?? null))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.spendCents - a.spendCents,
    );
}

/** Convenience for callers holding raw totals rather than a ChannelPeriod. */
export function toChannelPeriod(row: {
  channel: string;
  attributedRevenueCents: number;
  attributedConversions: number;
  spendCents: number;
}): ChannelPeriod {
  return {
    ...row,
    roas: ratio(row.attributedRevenueCents, row.spendCents),
    cac: ratio(row.spendCents, row.attributedConversions),
  };
}

/**
 * Organic Instagram performance — reach, views, engagement over a date range.
 *
 * Reads `social_insights_daily`, which `connectors/instagram` fills one day at a time.
 *
 * ## The one thing to get right here: reach cannot be summed
 *
 * Every other figure in this module is a count of events and adds up cleanly. Reach is a
 * count of *distinct accounts*, so adding two days double-counts everyone who saw you on
 * both. Summing 30 daily reach figures for this account gives ~2.53M against a true 30-day
 * unique reach of ~1.70M — a 49% overstatement, and both numbers look equally plausible.
 *
 * So this module deliberately does NOT expose a summed reach for a range. It exposes:
 *
 *  - `reachDailyAvg` — average daily unique reach, which is a real per-day figure.
 *  - `reachPeak` / `reachTrough` — the best and worst single days.
 *  - `summedReachUpperBound` — the sum, named as what it is: an upper bound you would only
 *    hit if no account ever saw you twice. Present because someone will otherwise compute it
 *    from the daily rows and quote it as reach.
 *
 * A true de-duplicated total for an arbitrary range can only come from asking Meta for that
 * exact range (`getAccountInsights`), because de-duplication needs the underlying accounts,
 * which we do not store. That is a connector call, not a query, so it is not in here.
 *
 * ## Engagement rate, and against what
 *
 * `engagementRatePerReach` divides accounts-engaged by reach — both are distinct-account
 * counts on the same day, so they share a denominator population and the ratio is meaningful.
 * Deliberately NOT divided by follower count: reach here runs 2-3x followers (most of it is
 * non-followers through Reels), so "engagement / followers" would exceed 100% and mean
 * nothing. Which boundary a rate uses has to be stated — same rule as margin.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";

export interface DailyInsightRow {
  date: string;
  reach: number | null;
  views: number | null;
  profileViews: number | null;
  accountsEngaged: number | null;
  totalInteractions: number | null;
}

export interface SocialInsightsSummary {
  platform: string;
  since: string;
  until: string;
  /** Days with at least one stored figure. */
  daysWithData: number;
  /** Days in the requested range, so the page can state coverage. */
  daysInRange: number;
  points: DailyInsightRow[];

  /** Average unique accounts reached per day. The honest per-day reach figure. */
  reachDailyAvg: number | null;
  reachPeak: { date: string; reach: number } | null;
  reachTrough: { date: string; reach: number } | null;
  /**
   * Sum of daily reach. NOT unique reach for the range — an upper bound only reached if no
   * account ever saw you twice. Named so it cannot be quoted as reach by accident.
   */
  summedReachUpperBound: number | null;

  /** These are event counts and do sum correctly. */
  views: number | null;
  profileViews: number | null;
  totalInteractions: number | null;

  /** Accounts engaged / accounts reached, same day, same population. */
  engagementRatePerReach: number | null;
  /** Views per account reached — how many times the average viewer saw you. */
  viewsPerReachedAccount: number | null;
  /** Profile visits per account reached — the closest thing to a click-through. */
  profileViewRatePerReach: number | null;
}

/**
 * Daily rows plus the aggregates that are safe to compute from them.
 *
 * `since`/`until` are inclusive. Missing days are simply absent rather than zero-filled: a
 * day Meta never gave us is not a day with no reach, and filling it with 0 would drag every
 * average down by however much data is missing.
 */
export async function getSocialInsights(
  platform: string,
  since: string,
  until: string,
): Promise<SocialInsightsSummary> {
  const rows = await db.execute<{
    captured_on: string;
    reach: number | null;
    views: number | null;
    profile_views: number | null;
    accounts_engaged: number | null;
    total_interactions: number | null;
  }>(sql`
    SELECT captured_on, reach, views, profile_views, accounts_engaged, total_interactions
    FROM social_insights_daily
    WHERE platform = ${platform}
      AND captured_on >= ${since}
      AND captured_on <= ${until}
    ORDER BY captured_on
  `);

  const points: DailyInsightRow[] = [...rows].map((r) => ({
    date: r.captured_on,
    reach: r.reach == null ? null : Number(r.reach),
    views: r.views == null ? null : Number(r.views),
    profileViews: r.profile_views == null ? null : Number(r.profile_views),
    accountsEngaged: r.accounts_engaged == null ? null : Number(r.accounts_engaged),
    totalInteractions: r.total_interactions == null ? null : Number(r.total_interactions),
  }));

  // Sum only over days that actually reported the metric, so a partially-covered range
  // gives a real average rather than one diluted by absent days.
  const nums = (pick: (p: DailyInsightRow) => number | null): number[] =>
    points.map(pick).filter((v): v is number => v !== null);

  const reachDays = nums((p) => p.reach);
  const engagedDays = nums((p) => p.accountsEngaged);
  const sum = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0);

  const withReach = points.filter((p): p is DailyInsightRow & { reach: number } => p.reach !== null);
  const peak =
    withReach.length === 0
      ? null
      : withReach.reduce((a, b) => (b.reach > a.reach ? b : a));
  const trough =
    withReach.length === 0
      ? null
      : withReach.reduce((a, b) => (b.reach < a.reach ? b : a));

  // `ratio` takes plain numbers; a null on either side here means "not measured", which is
  // a different thing from a zero denominator and must also come out as null.
  const safeRatio = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : ratio(a, b);

  const summedReach = sum(reachDays);
  const summedEngaged = sum(engagedDays);
  const views = sum(nums((p) => p.views));
  const profileViews = sum(nums((p) => p.profileViews));

  // Inclusive day count. Both bounds are YYYY-MM-DD so UTC parsing is exact.
  const daysInRange =
    Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) +
    1;

  return {
    platform,
    since,
    until,
    daysWithData: points.length,
    daysInRange,
    points,

    reachDailyAvg: reachDays.length === 0 ? null : (summedReach as number) / reachDays.length,
    reachPeak: peak ? { date: peak.date, reach: peak.reach } : null,
    reachTrough: trough ? { date: trough.date, reach: trough.reach } : null,
    summedReachUpperBound: summedReach,

    views,
    profileViews,
    totalInteractions: sum(nums((p) => p.totalInteractions)),

    // Ratios over the summed daily figures: both numerator and denominator are summed the
    // same way over the same days, so the inflation cancels and the rate holds even though
    // neither total is a unique count.
    engagementRatePerReach: safeRatio(summedEngaged, summedReach),
    viewsPerReachedAccount: safeRatio(views, summedReach),
    profileViewRatePerReach: safeRatio(profileViews, summedReach),
  };
}

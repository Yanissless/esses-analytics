/**
 * Follower growth against subscriber growth.
 *
 * The question this answers: is the audience we are building on social turning into
 * subscribers, and does a change in one show up in the other?
 *
 * ## The honesty problem, and why this module is mostly caveats
 *
 * Correlating two rising time series is the easiest way to produce a confident, wrong
 * number in analytics. Two things that both grow over time correlate at r > 0.9 whether
 * or not one causes the other — follower count and subscriber count both trend up, so a
 * naive Pearson r on the *levels* is guaranteed to look spectacular and mean nothing.
 *
 * So this module does three things differently:
 *
 *  1. **Correlates period-over-period CHANGES, not levels.** Growth in followers against
 *     growth in subscribers. This removes the shared trend that manufactures the false
 *     correlation. `correlateLevels` exists too, but only so the UI can show the
 *     difference and explain why the impressive number is the useless one.
 *  2. **Reports the sample size and refuses to answer on thin data.** r over five weekly
 *     points is noise. Below `MIN_POINTS_FOR_R` the functions return null — "not
 *     measurable" per rule 3, never 0.
 *  3. **Excludes interpolated observations.** A follower series that is half straight
 *     lines between two hand-entered points will correlate with anything. Rows with
 *     `source = 'estimated'` never enter a correlation.
 *
 * Lead/lag is the part with actual decision value: if follower growth leads subscriber
 * growth by two or three weeks, social is a leading indicator worth watching weekly. If
 * the best lag is zero or negative, followers are a lagging by-product of the same thing
 * driving subscriptions, and growing them is not a subscriber strategy. `bestLag` answers
 * that — with the same thin-data refusal, because the best of twelve lags on noisy data
 * is a maximum over noise.
 *
 * Every pure function below is unit-tested in tests/audience-growth.test.ts.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";

// ---------------------------------------------------------------------------
// Pure math (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Below this many paired observations, no correlation is reported.
 *
 * Twelve weekly points is a quarter — short, but enough that a single odd week cannot
 * dominate. Under it, r is arithmetic rather than evidence.
 */
export const MIN_POINTS_FOR_R = 12;

/**
 * Sources that represent a real observation rather than a filled-in gap.
 *
 * `meta_export` is included deliberately even though its *levels* are reconstructed: Meta
 * publishes daily new-follow counts, never historical totals, so a level series can only
 * ever be built by walking those deltas back from one known total. The deltas are exact,
 * which is what a correlation on changes consumes; only the vertical offset inherits the
 * anchor's rounding. Excluding it would throw away good change data over an offset that
 * doesn't affect the answer.
 */
export const OBSERVED_SOURCES = ["meta_api", "meta_export", "manual", "csv"] as const;

/**
 * Pearson correlation coefficient, or null when it isn't defined.
 *
 * Returns null on unequal lengths, on fewer than `MIN_POINTS_FOR_R` points, and when
 * either series has zero variance (a flat series correlates with nothing — the
 * denominator is 0, and rule 3 says that is "not measurable", not 0).
 */
export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < MIN_POINTS_FOR_R) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

/**
 * Period-over-period differences. Length is one less than the input.
 *
 * This is what turns "two things that both go up" into "do they move together".
 */
export function deltas(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) out.push(series[i] - series[i - 1]);
  return out;
}

export interface LagResult {
  /** Periods `x` leads `y` by. Positive means x moves first. */
  lag: number;
  r: number | null;
}

/**
 * Correlation of x against y at each lag from 0..maxLag, plus the best one.
 *
 * `lag = 2` means x at week t is compared with y at week t+2 — i.e. follower growth
 * leading subscriber growth by a fortnight. Only non-negative lags are searched: the
 * hypothesis under test is "does social growth precede subscriber growth", and letting
 * the search run negative invites reading a lagging indicator as a leading one.
 *
 * `best` is null when no lag has enough overlapping points to be measurable, which is
 * the common case early on — each lag costs you one more paired observation.
 */
export function lagProfile(xs: number[], ys: number[], maxLag = 8): {
  profile: LagResult[];
  best: LagResult | null;
} {
  const profile: LagResult[] = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    const x = xs.slice(0, xs.length - lag);
    const y = ys.slice(lag);
    const n = Math.min(x.length, y.length);
    profile.push({ lag, r: pearson(x.slice(0, n), y.slice(0, n)) });
  }
  const measurable = profile.filter((p): p is LagResult & { r: number } => p.r !== null);
  const best =
    measurable.length === 0
      ? null
      : measurable.reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a));
  return { profile, best };
}

/**
 * Compound growth rate per period across a series, or null if it can't be computed.
 *
 * Null rather than 0 when the series starts at zero or has fewer than two points —
 * "we had no followers and now have some" is an undefined rate, not an infinite one.
 */
export function periodGrowthRate(series: number[]): number | null {
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (first <= 0) return null;
  return Math.pow(last / first, 1 / (series.length - 1)) - 1;
}

/**
 * Rebases a series so its first value is 100.
 *
 * This is how two series with wildly different scales — ~18,000 followers against
 * ~2,000 subscribers — get compared on ONE axis. Plotting them against two y-axes is
 * the single most common charting mistake: the crossover point and the apparent gap
 * between the lines are both artefacts of where you happened to put the two scales, so
 * a dual-axis chart can show any relationship you like. Indexed to a common base, the
 * lines answer the question actually being asked — is follower growth outpacing
 * subscriber growth? — and the comparison is real.
 *
 * Returns null entries where the input is null, so a gap in a hand-entered follower
 * series stays a visible gap rather than being interpolated into a trend.
 */
export function indexToBase(series: Array<number | null>, base = 100): Array<number | null> {
  const firstReal = series.find((v): v is number => v !== null && v > 0);
  if (firstReal === undefined) return series.map(() => null);
  return series.map((v) => (v === null ? null : (v / firstReal) * base));
}

/**
 * Followers required per net new subscriber over the window.
 *
 * The blunt conversion figure, and the one most likely to be quoted out of context —
 * it is a ratio of two totals over the same window, not a causal cost. Null when the
 * subscriber count did not grow, because dividing by zero net adds is not "infinity
 * followers per subscriber", it is not measurable.
 */
export function followersPerSubscriber(
  followerGrowth: number,
  subscriberGrowth: number,
): number | null {
  return ratio(followerGrowth, subscriberGrowth);
}

// ---------------------------------------------------------------------------
// Series from the database
// ---------------------------------------------------------------------------

export interface AudiencePoint {
  /** ISO week start (Monday), YYYY-MM-DD. */
  weekStart: string;
  followers: number | null;
  /** True when every follower observation in this week was a real reading. */
  observed: boolean;
  /** Net active subscriptions at the end of this week. */
  subscribers: number;
  /**
   * Followers per subscriber this week.
   *
   * The honest way to put two different-scale totals on one chart: a ratio is a single
   * series with a single axis, so it needs no second scale and cannot be manipulated by
   * where that scale is placed. Falling means subscribers are growing faster than the
   * following — which, for a business that sells subscriptions, is the direction you want.
   */
  followersPerSubscriber: number | null;
}

/** Where the two totals stand right now, for the headline tiles. */
export interface AudienceLatest {
  weekStart: string | null;
  followers: number | null;
  subscribers: number | null;
  followersPerSubscriber: number | null;
}

export interface IndexedPoint {
  weekStart: string;
  /** Both rebased to 100 at the first week with a real follower reading. */
  followerIndex: number | null;
  subscriberIndex: number | null;
}

export interface AudienceGrowthAnalysis {
  points: AudiencePoint[];
  /** Ready to plot on a single axis — see `indexToBase` for why this exists. */
  indexed: IndexedPoint[];
  /** Current standing of both totals. */
  latest: AudienceLatest;
  /** Weeks with a real follower reading AND a subscriber figure. */
  pairedWeeks: number;
  followerGrowthRate: number | null;
  subscriberGrowthRate: number | null;
  /** r on weekly CHANGES — the number to trust. */
  deltaCorrelation: number | null;
  /** r on levels — reported only to be dismissed. Almost always ~0.9+ and meaningless. */
  levelCorrelation: number | null;
  lag: { profile: LagResult[]; best: LagResult | null };
  followersPerNetSubscriber: number | null;
  /** Everything the reader needs in order to not over-read the numbers above. */
  caveats: string[];
}

/**
 * Weekly follower observations per platform.
 *
 * Weekly rather than daily because a hand-entered series will have gaps, and a weekly
 * grain absorbs them without inventing values. Takes the LAST observation in each week
 * (a follower count is a level, not a sum) and flags the week as observed only when no
 * interpolated row contributed.
 */
export async function getFollowerSeries(platform = "instagram"): Promise<
  Array<{ weekStart: string; followers: number; observed: boolean }>
> {
  const rows = await db.execute<{ week_start: string; followers: number; observed: boolean }>(sql`
    SELECT
      to_char(date_trunc('week', captured_on)::date, 'YYYY-MM-DD') AS week_start,
      -- A follower count is a level: take the week's last reading, never a sum.
      (array_agg(followers ORDER BY captured_on DESC))[1]::int      AS followers,
      -- IN, not ANY-of-an-interpolated-array: drizzle's sql template expands a JS array
      -- as a tuple rather than a Postgres array, and Postgres rejects a tuple on the
      -- right of ANY. sql.join keeps each value a bound parameter. Gotcha in CLAUDE.md.
      -- (And never interpolate into a SQL comment — it becomes a bound parameter.)
      bool_and(source IN (${sql.join(
        OBSERVED_SOURCES.map((s) => sql`${s}`),
        sql`, `,
      )}))                                                          AS observed
    FROM social_audience
    WHERE platform = ${platform}
    GROUP BY date_trunc('week', captured_on)
    ORDER BY date_trunc('week', captured_on)
  `);
  return (rows as unknown as Array<{ week_start: string; followers: number; observed: boolean }>).map(
    (r) => ({ weekStart: r.week_start, followers: Number(r.followers), observed: Boolean(r.observed) }),
  );
}

/**
 * Net active subscriptions at the end of each week, across Skio and Stripe.
 *
 * Counts a subscription as active in a week if it started on or before that week's end
 * and had not been cancelled by then — a running level, so it is directly comparable
 * with a follower count. Skio subscriptions carry no cancellation timestamp in
 * `subscription_meta`, so their status is evaluated as of now; Stripe's `canceled_at`
 * gives a true historical cancellation. That asymmetry is reported as a caveat rather
 * than smoothed over: it means the early weeks of the Skio series are slightly
 * understated (subscriptions since cancelled are absent from history).
 */
export async function getSubscriberSeries(): Promise<Array<{ weekStart: string; subscribers: number }>> {
  const rows = await db.execute<{ week_start: string; subscribers: number }>(sql`
    WITH weeks AS (
      SELECT generate_series(
        date_trunc('week', (SELECT min(started_at) FROM subscription_meta WHERE started_at IS NOT NULL)),
        date_trunc('week', now()),
        interval '1 week'
      ) AS wk
    ),
    skio AS (
      SELECT w.wk, count(*)::int AS n
      FROM weeks w
      JOIN subscription_meta s
        ON s.started_at <= w.wk + interval '1 week' - interval '1 second'
       AND s.status = 'active'
      GROUP BY w.wk
    ),
    stripe AS (
      SELECT w.wk, count(*)::int AS n
      FROM weeks w
      JOIN stripe_subscriptions s
        ON s.started_at <= w.wk + interval '1 week' - interval '1 second'
       AND (s.canceled_at IS NULL OR s.canceled_at > w.wk + interval '1 week' - interval '1 second')
      GROUP BY w.wk
    )
    SELECT
      to_char(w.wk::date, 'YYYY-MM-DD')                    AS week_start,
      (COALESCE(k.n, 0) + COALESCE(t.n, 0))::int           AS subscribers
    FROM weeks w
    LEFT JOIN skio k   ON k.wk = w.wk
    LEFT JOIN stripe t ON t.wk = w.wk
    ORDER BY w.wk
  `);
  return (rows as unknown as Array<{ week_start: string; subscribers: number }>).map((r) => ({
    weekStart: r.week_start,
    subscribers: Number(r.subscribers),
  }));
}

/**
 * The whole analysis, assembled and caveated.
 *
 * Returns an empty-but-valid result when there is no follower data at all, so the page
 * can render an explanation of what is missing rather than an error.
 */
export async function getAudienceGrowth(platform = "instagram"): Promise<AudienceGrowthAnalysis> {
  const [followers, subscribers] = await Promise.all([
    getFollowerSeries(platform),
    getSubscriberSeries(),
  ]);

  const subsByWeek = new Map(subscribers.map((s) => [s.weekStart, s.subscribers]));
  const followersByWeek = new Map(followers.map((f) => [f.weekStart, f]));

  // Union of weeks, so the subscriber line still draws where follower data is absent.
  const weeks = [...new Set([...subsByWeek.keys(), ...followersByWeek.keys()])].sort();
  const points: AudiencePoint[] = weeks.map((weekStart) => {
    const f = followersByWeek.get(weekStart);
    const subscribers = subsByWeek.get(weekStart) ?? 0;
    const followers = f?.followers ?? null;
    return {
      weekStart,
      followers,
      observed: f?.observed ?? false,
      subscribers,
      // ratio() returns null at a zero denominator — rule 3. No subscribers yet is
      // "not measurable", not "infinite followers each".
      followersPerSubscriber: followers === null ? null : ratio(followers, subscribers),
    };
  });

  // Correlation runs only on weeks with a REAL follower reading and a subscriber figure.
  const paired = points.filter((p) => p.followers !== null && p.observed);
  const fs = paired.map((p) => p.followers as number);
  const ss = paired.map((p) => p.subscribers);

  const fd = deltas(fs);
  const sd = deltas(ss);

  const caveats: string[] = [];
  if (followers.length === 0) {
    caveats.push(
      "No follower observations recorded yet. Instagram follower data needs the " +
        "instagram_basic, instagram_manage_insights, pages_show_list and " +
        "pages_read_engagement scopes — all four are currently missing from the Meta " +
        "token — or a manual/CSV import via `run.cmd import:social`.",
    );
  }
  if (followers.length > 0 && paired.length < MIN_POINTS_FOR_R) {
    caveats.push(
      `Only ${paired.length} week(s) have a real follower reading; ${MIN_POINTS_FOR_R} are ` +
        "needed before a correlation means anything, so it is reported as not measurable.",
    );
  }
  const interpolated = points.filter((p) => p.followers !== null && !p.observed).length;
  if (interpolated > 0) {
    caveats.push(
      `${interpolated} week(s) hold interpolated follower values. They are drawn on the ` +
        "chart but excluded from every correlation — a straight line correlates with anything.",
    );
  }
  caveats.push(
    "Correlation is computed on weekly CHANGES, not levels. Two series that both trend " +
      "upward correlate near 1.0 regardless of any real relationship; the level figure is " +
      "shown only to make that point.",
  );
  caveats.push(
    "Skio subscriptions have no historical cancellation date, so their status is evaluated " +
      "as of today. Early weeks are therefore slightly understated — subscriptions since " +
      "cancelled do not appear in the history. Stripe cancellations are dated correctly.",
  );
  caveats.push(
    "A correlation here is not causation in either direction. Both series respond to the " +
      "same launches and press, which is the most likely explanation for any relationship.",
  );

  // Index over the window that actually has follower data, so the chart isn't mostly
  // empty. Both series rebase at the same week, which is what makes them comparable.
  const firstFollowerWeek = points.findIndex((p) => p.followers !== null);
  const window = firstFollowerWeek === -1 ? [] : points.slice(firstFollowerWeek);
  const followerIdx = indexToBase(window.map((p) => p.followers));
  const subscriberIdx = indexToBase(window.map((p) => (p.subscribers > 0 ? p.subscribers : null)));
  const indexed: IndexedPoint[] = window.map((p, i) => ({
    weekStart: p.weekStart,
    followerIndex: followerIdx[i],
    subscriberIndex: subscriberIdx[i],
  }));

  // Latest reads the last week that actually has a follower observation, not simply the
  // last week in the series: the subscriber series runs to today while a hand-entered
  // follower series may stop weeks earlier, and pairing today's subscriber count with a
  // month-old follower count would quietly overstate the ratio.
  const lastObserved = [...points].reverse().find((p) => p.followers !== null) ?? null;
  const latest: AudienceLatest = {
    weekStart: lastObserved?.weekStart ?? null,
    followers: lastObserved?.followers ?? null,
    subscribers: lastObserved?.subscribers ?? null,
    followersPerSubscriber: lastObserved?.followersPerSubscriber ?? null,
  };

  return {
    points,
    indexed,
    latest,
    pairedWeeks: paired.length,
    followerGrowthRate: periodGrowthRate(fs),
    subscriberGrowthRate: periodGrowthRate(ss),
    deltaCorrelation: pearson(fd, sd),
    levelCorrelation: pearson(fs, ss),
    lag: lagProfile(fd, sd),
    followersPerNetSubscriber:
      fs.length >= 2 && ss.length >= 2
        ? followersPerSubscriber(fs[fs.length - 1] - fs[0], ss[ss.length - 1] - ss[0])
        : null,
    caveats,
  };
}

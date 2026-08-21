/**
 * Readership, from GA4.
 *
 * The question this answers and nothing else in the app can: which articles are being read.
 * Every other metric here begins with an order, so an article read by 8,000 people who bought
 * nothing does not exist as far as the rest of the app is concerned — and for a magazine
 * selling sponsored features, readership is the thing being sold.
 *
 * ## What it deliberately refuses to do
 *
 * It never claims an article drove a sale. GA4 has its own attribution model, ours is built
 * from order data, the two will disagree, and there is no way to adjudicate from outside. So
 * the split shown here is COMPOSITION — how traffic divides between editorial and commerce
 * pages — which is a fact about traffic, not a claim about causation.
 *
 * ## The `(other)` problem, and why totals come from a second query
 *
 * Past a cardinality limit GA4 stops itemising pages and returns one `(other)` bucket. When
 * that happens the per-page rows do not sum to the day, so "the top ten articles are 40% of
 * traffic" computed from page rows is wrong by an unknown amount in the flattering direction.
 * `content_day_quality` stores the day totals from a query with no page dimension, and every
 * share on this page is computed against those. Where the bucket applies, the share is withheld
 * rather than estimated.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { classifyPath, isContentKind, type PageKind } from "../connectors/ga4/shape";

export interface ContentRange {
  since: string;
  until: string;
}

export interface PageRow {
  pagePath: string;
  pageTitle: string | null;
  kind: PageKind;
  sessions: number;
  views: number;
  entrances: number;
  engagedSessions: number;
  engagementSeconds: number;
  /** Days in range this page had any traffic — separates one viral day from steady readership. */
  activeDays: number;
  /** Any contributing row still inside GA4's reprocessing window. */
  provisional: boolean;
}

/**
 * Seconds of engagement per session, or null.
 *
 * Null rather than 0 when there are no sessions: a page with no readers has no average
 * engagement time, and 0 would sort it alongside a page everyone bounced from — which is a
 * completely different thing (rule: ratios return null, never 0 or Infinity).
 */
export function engagementPerSession(row: {
  engagementSeconds: number;
  sessions: number;
}): number | null {
  return row.sessions > 0 ? row.engagementSeconds / row.sessions : null;
}

/**
 * Share of sessions that were engaged, or null.
 *
 * The readership-quality signal that matters when selling a sponsored feature: 5,000 sessions
 * that all bounced is not the same product as 5,000 that read to the end.
 */
export function engagedShare(row: {
  engagedSessions: number;
  sessions: number;
}): number | null {
  return row.sessions > 0 ? row.engagedSessions / row.sessions : null;
}

/**
 * Pages in range, ranked by sessions.
 *
 * Kind is computed here rather than stored, so correcting a classification pattern fixes every
 * historical row at once instead of requiring a backfill. The classifier is partly inference —
 * esses.com's editorial paths never appear in order data — so it WILL need correcting, which is
 * exactly why it isn't baked into the table.
 */
export async function getTopPages(
  range: ContentRange,
  opts: { limit?: number; kinds?: PageKind[] } = {},
): Promise<PageRow[]> {
  const rows = await db.execute<{
    page_path: string;
    page_title: string | null;
    sessions: number;
    views: number;
    entrances: number;
    engaged_sessions: number;
    engagement_seconds: number;
    active_days: number;
    provisional: boolean;
  }>(sql`
    SELECT page_path,
           -- The title from the highest-traffic day, matching how the connector picks a title
           -- within a day: the name the page had while most people were reading it.
           (array_agg(page_title ORDER BY views DESC NULLS LAST))[1] AS page_title,
           sum(sessions)::bigint            AS sessions,
           sum(views)::bigint               AS views,
           sum(entrances)::bigint           AS entrances,
           sum(engaged_sessions)::bigint    AS engaged_sessions,
           sum(engagement_seconds)::bigint  AS engagement_seconds,
           count(*)::int                    AS active_days,
           bool_or(is_provisional)          AS provisional
      FROM content_metrics
     WHERE date >= ${range.since} AND date <= ${range.until}
     GROUP BY page_path
     ORDER BY sessions DESC
     LIMIT ${Math.min(opts.limit ?? 50, 500) * 4}
  `);

  // Classified in TypeScript, then filtered, then trimmed. The SQL over-fetches (×4) because a
  // kind filter cannot be applied in the query without duplicating the classifier in SQL — and
  // this codebase has already been bitten twice by a predicate existing in two places
  // (`revenue_class`, the rate-rule predicate). One definition, in one language.
  const all = [...rows].map((r) => ({
    pagePath: r.page_path,
    pageTitle: r.page_title,
    kind: classifyPath(r.page_path),
    sessions: Number(r.sessions),
    views: Number(r.views),
    entrances: Number(r.entrances),
    engagedSessions: Number(r.engaged_sessions),
    engagementSeconds: Number(r.engagement_seconds),
    activeDays: Number(r.active_days),
    provisional: Boolean(r.provisional),
  }));

  const filtered = opts.kinds ? all.filter((r) => opts.kinds!.includes(r.kind)) : all;
  return filtered.slice(0, opts.limit ?? 50);
}

export interface KindSplit {
  kind: PageKind;
  sessions: number;
  views: number;
  pages: number;
}

/**
 * How traffic divides between editorial and commerce.
 *
 * Composition, not attribution — see the note at the top of the file. Reads every row rather
 * than a top-N, because a split computed from the top 50 pages is a split of the top 50 pages.
 */
export async function getKindSplit(range: ContentRange): Promise<KindSplit[]> {
  const rows = await db.execute<{
    page_path: string;
    sessions: number;
    views: number;
  }>(sql`
    SELECT page_path, sum(sessions)::bigint AS sessions, sum(views)::bigint AS views
      FROM content_metrics
     WHERE date >= ${range.since} AND date <= ${range.until}
     GROUP BY page_path
  `);

  const byKind = new Map<PageKind, KindSplit>();
  for (const r of rows) {
    const kind = classifyPath(r.page_path);
    const cur = byKind.get(kind) ?? { kind, sessions: 0, views: 0, pages: 0 };
    cur.sessions += Number(r.sessions);
    cur.views += Number(r.views);
    cur.pages += 1;
    byKind.set(kind, cur);
  }

  return [...byKind.values()].sort((a, b) => b.sessions - a.sessions);
}

export interface ContentCoverage {
  /** Days in range GA4 has answered for. */
  daysWithData: number;
  /** Days in the range at all — the gap between the two is missing data. */
  daysInRange: number;
  firstDay: string | null;
  lastDay: string | null;
  /** True day totals from the no-page-dimension query. The honest denominator. */
  totalSessions: number;
  totalViews: number;
  /** Sessions itemised per page. Lower than totalSessions wherever `(other)` applied. */
  itemisedSessions: number;
  /** Days where GA4 collapsed the tail into `(other)`. */
  daysWithOtherRow: number;
  /** Sessions hidden inside `(other)` across the range — the size of the blind spot. */
  hiddenSessions: number;
  /** Days GA4 answered from a sample. */
  sampledDays: number;
  /** Days still inside the ~48h reprocessing window. */
  provisionalDays: number;
}

/**
 * What the range can and cannot support.
 *
 * Every caveat on the page comes from here rather than being recomputed per card, so a claim
 * and its caveat cannot drift apart.
 */
export async function getCoverage(range: ContentRange): Promise<ContentCoverage> {
  const [quality] = [
    ...(await db.execute<{
      days: number;
      first_day: string | null;
      last_day: string | null;
      total_sessions: number;
      total_views: number;
      other_days: number;
      hidden: number;
      sampled_days: number;
    }>(sql`
      SELECT count(*)::int                                      AS days,
             min(date)::text                                    AS first_day,
             max(date)::text                                    AS last_day,
             COALESCE(sum(total_sessions), 0)::bigint           AS total_sessions,
             COALESCE(sum(total_views), 0)::bigint              AS total_views,
             count(*) FILTER (WHERE has_other_row)::int         AS other_days,
             COALESCE(sum(other_sessions), 0)::bigint           AS hidden,
             count(*) FILTER (WHERE sampled)::int               AS sampled_days
        FROM content_day_quality
       WHERE date >= ${range.since} AND date <= ${range.until}
    `)),
  ];

  const [itemised] = [
    ...(await db.execute<{ sessions: number; provisional_days: number }>(sql`
      SELECT COALESCE(sum(sessions), 0)::bigint                       AS sessions,
             count(DISTINCT date) FILTER (WHERE is_provisional)::int  AS provisional_days
        FROM content_metrics
       WHERE date >= ${range.since} AND date <= ${range.until}
    `)),
  ];

  const daysInRange =
    Math.round(
      (Date.parse(`${range.until}T00:00:00Z`) - Date.parse(`${range.since}T00:00:00Z`)) /
        86_400_000,
    ) + 1;

  return {
    daysWithData: Number(quality?.days ?? 0),
    daysInRange,
    firstDay: quality?.first_day ?? null,
    lastDay: quality?.last_day ?? null,
    totalSessions: Number(quality?.total_sessions ?? 0),
    totalViews: Number(quality?.total_views ?? 0),
    itemisedSessions: Number(itemised?.sessions ?? 0),
    daysWithOtherRow: Number(quality?.other_days ?? 0),
    hiddenSessions: Number(quality?.hidden ?? 0),
    sampledDays: Number(quality?.sampled_days ?? 0),
    provisionalDays: Number(itemised?.provisional_days ?? 0),
  };
}

/**
 * Share of the range's traffic a set of pages accounts for — or null when it can't be known.
 *
 * ## Why this returns null so readily
 *
 * A share needs a trustworthy denominator. Two things destroy one, and both are common:
 *
 *  - GA4 applied its `(other)` bucket, so an unknown quantity of traffic was never itemised.
 *    Any share computed against the itemised rows is then inflated by an unknown factor.
 *  - The day totals are missing entirely, so there is nothing to divide by.
 *
 * Returning a number anyway would be the most quotable figure on the page and the least
 * reliable. Withholding it is the honest option, and the caller says why.
 */
export function shareOfTraffic(
  sessions: number,
  coverage: ContentCoverage,
): { share: number | null; reason?: string } {
  if (coverage.totalSessions <= 0) {
    return { share: null, reason: "no day totals for this range" };
  }
  if (coverage.daysWithOtherRow > 0) {
    return {
      share: null,
      reason:
        `GA4 hid ${coverage.hiddenSessions.toLocaleString("en-US")} session(s) in an "(other)" ` +
        `bucket across ${coverage.daysWithOtherRow} day(s), so per-page rows do not sum to the range`,
    };
  }
  return { share: sessions / coverage.totalSessions };
}

/**
 * Sessions reaching pages we could not classify, as a share of ITEMISED sessions.
 *
 * ## The denominator, named
 *
 * Both this and `editorialShare` divide by the sum of the per-page rows, not by the day totals.
 * Where GA4 applied its `(other)` bucket those differ, and the gap can be large — a seeded case
 * ran 1,670 itemised against 2,570 real sessions, leaving 35% of traffic outside any category.
 *
 * Unlike `shareOfTraffic`, the number is not withheld, because a composition of the itemised
 * rows is a true statement about the itemised rows. But the caller MUST label the denominator,
 * and the page shows the unallocated remainder beside it. Quoting a share without naming what
 * it is a share OF is how a figure goes wrong while every input stays right — the same reason
 * a margin is never quoted without its boundary.
 */
export function unclassifiedShare(split: KindSplit[]): number | null {
  const total = split.reduce((a, s) => a + s.sessions, 0);
  if (total <= 0) return null;
  const unknown = split.find((s) => s.kind === "unclassified")?.sessions ?? 0;
  return unknown / total;
}

/**
 * Sessions on editorial pages as a share of ITEMISED sessions.
 *
 * Composition, not attribution — and a share of the itemised rows, not of all traffic. See the
 * note on `unclassifiedShare` for why that distinction has to reach the label.
 */
export function editorialShare(split: KindSplit[]): number | null {
  const total = split.reduce((a, s) => a + s.sessions, 0);
  if (total <= 0) return null;
  const editorial = split
    .filter((s) => isContentKind(s.kind))
    .reduce((a, s) => a + s.sessions, 0);
  return editorial / total;
}

export interface DailyTraffic {
  date: string;
  sessions: number;
  views: number;
  provisional: boolean;
}

/** Day-by-day totals for the range, from the honest denominator table. */
export async function getDailyTraffic(range: ContentRange): Promise<DailyTraffic[]> {
  const rows = await db.execute<{
    date: string;
    sessions: number;
    views: number;
    provisional: boolean;
  }>(sql`
    SELECT q.date::text                                AS date,
           q.total_sessions::bigint                    AS sessions,
           q.total_views::bigint                       AS views,
           COALESCE(bool_or(m.is_provisional), false)  AS provisional
      FROM content_day_quality q
      LEFT JOIN content_metrics m ON m.date = q.date
     WHERE q.date >= ${range.since} AND q.date <= ${range.until}
     GROUP BY q.date, q.total_sessions, q.total_views
     ORDER BY q.date
  `);

  return [...rows].map((r) => ({
    date: r.date,
    sessions: Number(r.sessions),
    views: Number(r.views),
    provisional: Boolean(r.provisional),
  }));
}

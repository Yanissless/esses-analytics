/**
 * GA4 content metrics connector.
 *
 * Scope, stated once because the temptation to widen it is constant: sessions and pageviews by
 * page path, and nothing else. No source, medium or campaign dimensions, and no conversions.
 * GA4 runs its own attribution model which will disagree with ours, and with no way to
 * adjudicate between them from outside, having both would mean two answers to "where did this
 * revenue come from" and no basis for picking one. Attribution stays in one place.
 *
 * What this adds that nothing else in the app can: traffic that never converts. Every other
 * number here starts from an order, so an article read by 8,000 people who bought nothing is
 * currently invisible — and for a magazine selling sponsored features, readership is the
 * product being sold.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { contentDayQuality, contentMetrics } from "../../db/schema";
import { connectorConfigured } from "../../lib/env";
import { logger } from "../../lib/logger";
import type { Connector, SyncResult, SyncWindow } from "../types";
import { fetchDayTotals, fetchPageReport, ga4HealthCheck } from "./client";
import { parseGa4Date, provisionalFrom, shapeRows, type ShapedRow } from "./shape";

/**
 * How far back an incremental run re-reads.
 *
 * Not 1 day. GA4 revises the last ~48 hours, and a run that only ever fetched yesterday would
 * store yesterday's provisional numbers and never come back for the settled ones — leaving a
 * permanent trail of undercounted days. Three days covers the 48-hour window with a margin for
 * a run that lands late.
 */
export const INCREMENTAL_LOOKBACK_DAYS = 3;

/**
 * GA4's standard-tier retention.
 *
 * Free properties keep event-level data for 2 or 14 months depending on a setting, and queries
 * beyond it return an empty report rather than an error. A backfill asking for 2024 therefore
 * "succeeds" with nothing, which reads as "the site had no traffic". Bounded here so the
 * connector reports the limit instead of a silent zero.
 */
export const MAX_LOOKBACK_DAYS = 14 * 30;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * Write shaped rows.
 *
 * Chunked because a wide window over a content-heavy site runs to tens of thousands of rows,
 * and Postgres has a hard cap on bind parameters per statement — with 10 columns a single
 * statement would blow past it and fail on the size of the data rather than anything wrong
 * with it.
 */
async function upsertRows(rows: ShapedRow[]): Promise<number> {
  const CHUNK = 500;
  let written = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db
      .insert(contentMetrics)
      .values(chunk)
      .onConflictDoUpdate({
        target: [contentMetrics.date, contentMetrics.pagePath],
        set: {
          pageTitle: sql`excluded.page_title`,
          sessions: sql`excluded.sessions`,
          views: sql`excluded.views`,
          users: sql`excluded.users`,
          engagedSessions: sql`excluded.engaged_sessions`,
          engagementSeconds: sql`excluded.engagement_seconds`,
          entrances: sql`excluded.entrances`,
          // Overwritten, not OR-ed. A re-read outside the processing window is how a row stops
          // being provisional, so preserving the old true would pin it there forever.
          isProvisional: sql`excluded.is_provisional`,
          updatedAt: sql`now()`,
        },
      });
    written += chunk.length;
  }

  return written;
}

async function upsertDayQuality(
  totals: Array<{ date: string; sessions: number; views: number }>,
  otherByDate: Map<string, number>,
  rowsPerDate: Map<string, number>,
  meta: { hasOtherRow: boolean; sampled: boolean },
): Promise<void> {
  const values = totals
    .map((t) => {
      const date = parseGa4Date(t.date);
      if (!date) return null;
      const other = otherByDate.get(date) ?? 0;
      return {
        date,
        rowsReturned: rowsPerDate.get(date) ?? 0,
        // Per-day, not the report-wide flag: GA4 applies the bucket per query, and attributing
        // it to every day in the window would mark clean days as compromised.
        hasOtherRow: other > 0,
        otherSessions: other,
        sampled: meta.sampled,
        totalSessions: t.sessions,
        totalViews: t.views,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (values.length === 0) return;

  await db
    .insert(contentDayQuality)
    .values(values)
    .onConflictDoUpdate({
      target: contentDayQuality.date,
      set: {
        rowsReturned: sql`excluded.rows_returned`,
        hasOtherRow: sql`excluded.has_other_row`,
        otherSessions: sql`excluded.other_sessions`,
        sampled: sql`excluded.sampled`,
        totalSessions: sql`excluded.total_sessions`,
        totalViews: sql`excluded.total_views`,
        updatedAt: sql`now()`,
      },
    });
}

async function load(since: Date, until: Date): Promise<SyncResult> {
  const warnings: string[] = [];

  const oldest = daysAgo(MAX_LOOKBACK_DAYS);
  let startDate = iso(since);
  if (since < oldest) {
    startDate = iso(oldest);
    warnings.push(
      `window clamped to GA4's ${MAX_LOOKBACK_DAYS}-day retention (asked for ${iso(since)}, ` +
        `fetched from ${startDate}) — earlier data is not recoverable from the API`,
    );
  }
  const endDate = iso(until);

  const [report, totals] = await Promise.all([
    fetchPageReport(startDate, endDate),
    fetchDayTotals(startDate, endDate),
  ]);

  const shaped = shapeRows(report.rows, provisionalFrom(new Date()));

  if (shaped.droppedRows > 0) {
    // Should be impossible: GA4's date dimension is always YYYYMMDD. Loud rather than silent,
    // because if it ever happens the alternative is rows quietly missing from every range query.
    warnings.push(`${shaped.droppedRows} row(s) had an unparseable date and were skipped`);
  }

  if (report.meta.hasOtherRow) {
    const hidden = [...shaped.otherByDate.values()].reduce((a, b) => a + b, 0);
    warnings.push(
      `GA4 collapsed low-traffic pages into "(other)" on ${shaped.otherByDate.size} day(s), ` +
        `hiding ${hidden.toLocaleString("en-US")} session(s) — per-page rows do not sum to the ` +
        `day on those days`,
    );
  }

  if (report.meta.sampled) {
    warnings.push("GA4 answered from a sample, so these figures are estimates");
  }

  const rowsPerDate = new Map<string, number>();
  for (const r of shaped.rows) {
    rowsPerDate.set(r.date, (rowsPerDate.get(r.date) ?? 0) + 1);
  }

  const written = await upsertRows(shaped.rows);
  await upsertDayQuality(totals, shaped.otherByDate, rowsPerDate, report.meta);

  logger.info("GA4 content synced", {
    startDate,
    endDate,
    rowsIn: report.rows.length,
    written,
    days: totals.length,
    hasOtherRow: report.meta.hasOtherRow,
  });

  return {
    source: "ga4",
    rowsIn: report.rows.length,
    rowsUpserted: written,
    warnings,
    // The window end, so the next incremental knows where it got to. Re-read overlap is added
    // by incrementalSync rather than baked in here.
    cursor: endDate,
  };
}

export const ga4Connector: Connector = {
  source: "ga4",

  isConfigured: () => connectorConfigured.ga4(),

  healthCheck: ga4HealthCheck,

  backfill: (window: SyncWindow) => load(window.since, window.until ?? new Date()),

  /**
   * Catch up, always re-reading the processing window.
   *
   * The cursor is where the last run finished, but the lookback is applied regardless: the last
   * two days of any previous run were provisional by definition, so resuming exactly at the
   * cursor would leave them at their first, low reading forever.
   */
  incrementalSync: async (cursor?: string) => {
    const until = new Date();
    const lookbackStart = daysAgo(INCREMENTAL_LOOKBACK_DAYS);

    if (!cursor) {
      // No cursor means nothing has ever synced. Take the full retention window rather than
      // inventing a small one — same posture as the other connectors, which fall back to a
      // full walk rather than guessing.
      return load(daysAgo(MAX_LOOKBACK_DAYS), until);
    }

    const from = new Date(`${cursor}T00:00:00Z`);
    const since =
      Number.isNaN(from.getTime()) || from > lookbackStart ? lookbackStart : from;
    return load(since, until);
  },
};

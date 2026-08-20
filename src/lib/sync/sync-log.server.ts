/**
 * The record of what the app has done to its own data, and how reliably.
 *
 * ## Why this exists
 *
 * Once data updates itself unprompted, nobody watches it happen. The refresh runs on a page
 * view or a cron, succeeds or fails quietly, and the dashboard looks identical either way — the
 * numbers are simply older than they appear. The nav indicator says "Couldn't update data" for
 * about a second and then the page is just a page again.
 *
 * So the automation needs a record you can look at afterwards. Not for its own sake: the two
 * worst data bugs in this app so far were both invisible at the figure and obvious in the run
 * log. Meta spend at 43% of the real number was a run that fetched a day while the day was
 * still going. Shopify frozen for two weeks was runs completing with `partial` status — every
 * one of them recorded, none of them looked at.
 *
 * ## Why reliability is counted over recent runs, not the last one
 *
 * "Did the last run succeed?" is the question that hid the Shopify bug. A source that fails one
 * run in three is broken, and every third check of it says everything is fine. Counting a
 * window makes the intermittent case visible, which is the case you cannot spot by eye.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client";

/** How many recent runs per source the reliability count considers. */
export const RELIABILITY_WINDOW = 20;

/**
 * Enough runs for a failure rate to mean anything.
 *
 * Below this the page reports raw counts and no rate. One failure out of two is not a 50%
 * failure rate, and printing it as one sends someone chasing a problem that a single transient
 * network error explains. Same floor reasoning as MIN_MATURED_TO_RATE in promo-cohorts and
 * MIN_SUBS_FOR_DIVERGENCE in renewal-forecast.
 */
export const MIN_RUNS_TO_RATE = 5;

/**
 * How many runs a warning must appear in before it counts as a standing condition rather than
 * something that went wrong this time.
 *
 * ## Why this distinction has to exist
 *
 * `finishSyncRun` marks a run `partial` whenever it carries any warning at all. That is the
 * right default and it produces a badly misleading summary, which this page surfaced the moment
 * it was built: Shopify read as 16 partial runs out of 20, an 85% trouble rate. The 16 were two
 * standing conditions repeating — a missing `read_reports` scope, and shipping labels whose
 * orders fall outside the sync window, which a windowed sync will always produce.
 *
 * Neither is an incident. Both are worth fixing. But a source that is amber every single run is
 * a source whose status tells you nothing, and a genuinely new problem there would be invisible
 * against the noise. That is alert fatigue arriving structurally rather than by anyone's choice.
 *
 * ## Why it's derived from the runs and not declared by the connector
 *
 * A connector could label its own warnings "expected". Recurrence is the better signal, because
 * it needs nobody to have remembered: anything that keeps happening is by definition standing,
 * including the conditions nobody thought to classify. It also catches the reverse — a warning
 * labelled expected that suddenly stops recurring says something changed.
 *
 * Three rather than two because Shopify's two standing warnings alternate run to run, so a
 * threshold of two would let a genuinely repeated pair look like a pair of one-offs.
 */
export const STANDING_MIN_RUNS = 3;

export interface SyncRunRow {
  id: string;
  source: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  /** Null while a run is still going, or when it was killed without writing a finish. */
  durationMs: number | null;
  rowsIn: number;
  rowsUpserted: number;
  error: string | null;
  warnings: string[];
}

export interface SourceReliability {
  source: string;
  /** Settled runs in the window. A run still in flight is counted in neither column. */
  runs: number;
  succeeded: number;
  partial: number;
  failed: number;
  /** Null below MIN_RUNS_TO_RATE — see the note on that constant. */
  failureRate: number | null;
  /**
   * Runs that failed, or carried a warning that is NOT a standing condition.
   *
   * This is the number to look at. `partial` alone conflates "something went wrong this run"
   * with "the same known gap as every other run" — see STANDING_MIN_RUNS.
   */
  anomalies: number;
  /** Null below MIN_RUNS_TO_RATE, same reasoning as failureRate. */
  anomalyRate: number | null;
  /** Warnings recurring across the window: known gaps, not incidents. Worth fixing, not alarming. */
  standingWarnings: string[];
  /** Warnings that appeared in the most recent run and are not standing. The actionable set. */
  newWarnings: string[];
  /** Median completed duration, for spotting a source drifting toward a timeout. */
  medianMs: number | null;
  /** The most recent run's status, whatever it was. */
  latestStatus: string | null;
}

/**
 * Reliability per source, as a pure function of the rows.
 *
 * Pure so the counting rules are testable without a database — the same split as
 * `decideRefresh` and `wallOutcome`. What it must not do is quietly treat `partial` as success:
 * a partial run is one that completed while telling you something was wrong, and collapsing
 * that into "fine" is exactly the reading that let Shopify sit frozen for two weeks.
 */
export function summariseReliability(rows: SyncRunRow[]): SourceReliability[] {
  const bySource = new Map<string, SyncRunRow[]>();
  for (const r of rows) {
    const list = bySource.get(r.source);
    if (list) list.push(r);
    else bySource.set(r.source, [r]);
  }

  const out: SourceReliability[] = [];
  for (const [source, all] of bySource) {
    // Newest first, so the window is the most RECENT runs. A source fixed last week should not
    // read as broken because of the month before it.
    const sorted = [...all].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const window = sorted.slice(0, RELIABILITY_WINDOW);

    // A run still in flight is not evidence either way — it has neither succeeded nor failed.
    const settled = window.filter((r) => r.status !== "running");
    const succeeded = settled.filter((r) => r.status === "success").length;
    const partial = settled.filter((r) => r.status === "partial").length;
    const failed = settled.filter((r) => r.status === "failed").length;

    const durations = window
      .map((r) => r.durationMs)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);

    // How many DISTINCT runs each warning text appeared in. Counted per run rather than per
    // occurrence so one run repeating a warning cannot promote it to standing on its own.
    const runsWithWarning = new Map<string, number>();
    for (const r of settled) {
      for (const w of new Set(r.warnings)) {
        runsWithWarning.set(w, (runsWithWarning.get(w) ?? 0) + 1);
      }
    }
    const standing = new Set(
      [...runsWithWarning].filter(([, n]) => n >= STANDING_MIN_RUNS).map(([w]) => w),
    );

    // A failure is always an anomaly. A partial is one only if it carries something new.
    const anomalies = settled.filter(
      (r) => r.status === "failed" || r.warnings.some((w) => !standing.has(w)),
    ).length;

    const latest = window[0];

    out.push({
      source,
      runs: settled.length,
      succeeded,
      partial,
      failed,
      // Kept for transparency: this is the raw status count, before the standing/new split.
      // Partial counts against it, because it means "completed, and something was wrong".
      failureRate:
        settled.length >= MIN_RUNS_TO_RATE ? (failed + partial) / settled.length : null,
      anomalies,
      anomalyRate: settled.length >= MIN_RUNS_TO_RATE ? anomalies / settled.length : null,
      standingWarnings: [...standing].sort(),
      newWarnings: (latest?.warnings ?? []).filter((w) => !standing.has(w)),
      medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      latestStatus: latest?.status ?? null,
    });
  }

  // Worst first: the source that needs attention should not be somewhere down the list. Ranked
  // on anomalies rather than raw partial count, or the source with two known gaps and nothing
  // actually wrong would permanently outrank the one that broke this morning.
  return out.sort((a, b) => {
    const rank = (s: SourceReliability) =>
      s.newWarnings.length > 0 || s.latestStatus === "failed"
        ? 0
        : s.anomalies > 0
          ? 1
          : s.standingWarnings.length > 0
            ? 2
            : 3;
    return rank(a) - rank(b) || a.source.localeCompare(b.source);
  });
}

/** The most recent runs across all sources, newest first. */
export async function getRecentRuns(limit = 60): Promise<SyncRunRow[]> {
  const rows = await db.execute<{
    id: string;
    source: string;
    mode: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    duration_ms: string | number | null;
    rows_in: number;
    rows_upserted: number;
    error: string | null;
    warnings: unknown;
  }>(sql`
    SELECT id, source, mode, status,
           started_at::text  AS started_at,
           finished_at::text AS finished_at,
           CASE WHEN finished_at IS NULL THEN NULL
                ELSE round(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)
           END               AS duration_ms,
           rows_in, rows_upserted, error, warnings
      FROM sync_runs
     ORDER BY started_at DESC
     LIMIT ${limit}
  `);

  return [...rows].map((r) => ({
    id: r.id,
    source: r.source,
    mode: r.mode,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    rowsIn: Number(r.rows_in),
    rowsUpserted: Number(r.rows_upserted),
    error: r.error,
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
  }));
}

/**
 * Runs for the reliability window, which needs different history from the display list.
 *
 * Queried separately rather than reusing `getRecentRuns`: with six sources, the newest 60 runs
 * might be forty of one source and two of another, so a rate computed off the display list
 * would silently be a rate over whatever happened to be in it. The window has to be per source,
 * which is what the `row_number()` partition does.
 */
export async function getReliability(): Promise<SourceReliability[]> {
  const rows = await db.execute<{
    id: string;
    source: string;
    mode: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    duration_ms: string | number | null;
    warnings: unknown;
  }>(sql`
    SELECT id, source, mode, status,
           started_at::text  AS started_at,
           finished_at::text AS finished_at,
           CASE WHEN finished_at IS NULL THEN NULL
                ELSE round(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)
           END               AS duration_ms,
           warnings
      FROM (
        SELECT *, row_number() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
          FROM sync_runs
      ) ranked
     WHERE rn <= ${RELIABILITY_WINDOW}
  `);

  return summariseReliability(
    [...rows].map((r) => ({
      id: r.id,
      source: r.source,
      mode: r.mode,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      // Needed here, not just for display: the standing/new split is computed from them.
      warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
      // Not selected — the reliability view is about outcomes and timing, not volumes.
      rowsIn: 0,
      rowsUpserted: 0,
      error: null,
    })),
  );
}

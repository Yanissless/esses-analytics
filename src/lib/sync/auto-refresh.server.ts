/**
 * Deciding whether the app should refresh its own data, right now, unprompted.
 *
 * Sam's requirement: "it should be build to update on the page itself without any user or
 * system interacting with it." No clicking, no Windows scheduler, no separate process.
 *
 * ## What this replaces and why it isn't the whole answer
 *
 * The honest limit, stated once so nobody is surprised by it: this can only run while the app
 * is running. Close the window and nothing refreshes. That is fine for the daily rhythm Sam
 * described — the app is open most days — and it is NOT sufficient for Instagram, whose
 * follower history Meta serves over a rolling 30 days and never publishes again. A week with
 * the app shut is a week of follower history gone permanently. The Vercel cron in vercel.json
 * is the real fix for that, and it takes over on deploy.
 *
 * ## Four gates, each closing a specific failure
 *
 * **1. Staleness.** Only refresh when the data is actually old. Without this every page view
 * would trigger a sync, which on a four-person team means spending third-party API calls
 * dozens of times an hour to learn nothing changed.
 *
 * **2. Cooldown.** Never more than once per `COOLDOWN_MINUTES`, even when still stale. A source
 * that is genuinely failing stays stale forever, and without a cooldown that turns into an
 * infinite retry loop billed per attempt. This is the gate that matters when something is
 * broken, which is exactly when nobody is watching.
 *
 * **3. In-flight.** One sync at a time. Four people opening the dashboard at 9am must not
 * start four concurrent syncs writing the same rows.
 *
 * **4. Interactive-only.** Never triggered from a background request. Derived from a real page
 * render, so it cannot fire on a health check or a crawler.
 *
 * ## The lock needs no new table
 *
 * A run in flight is one with `started_at` set and `finished_at` null. `sync_runs` already
 * records both, so the lock is a query rather than a mechanism — and it is observable, because
 * you can see the row.
 *
 * It has a TTL for a reason established the hard way: when a platform kills a serverless
 * function mid-run, the kill comes from outside the process and the finish is never written. A
 * lock without expiry would then wedge refreshes forever, with the freshness banner still
 * claiming the data was fine. `IN_FLIGHT_TTL_MINUTES` bounds that to one window.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client";

/** Refresh when the newest completed sync is older than this. */
export const STALE_AFTER_MINUTES = 6 * 60;

/**
 * Minimum gap between automatic refreshes, whatever the staleness says.
 *
 * The load-bearing case is a source that is failing: it never becomes fresh, so staleness
 * alone would re-trigger on every page view indefinitely. Third-party calls cost money.
 */
export const COOLDOWN_MINUTES = 30;

/** After this, an unfinished run is assumed dead rather than in flight. See the note above. */
export const IN_FLIGHT_TTL_MINUTES = 15;

export type RefreshDecision =
  | { refresh: true; reason: string; ageMinutes: number | null }
  | {
      refresh: false;
      reason: string;
      blockedBy: "fresh" | "cooldown" | "in-flight" | "never-synced-manually";
      ageMinutes: number | null;
    };

export interface RefreshFacts {
  /** Minutes since the newest COMPLETED run. Null when none has ever completed. */
  ageMinutes: number | null;
  /** Minutes since the newest run STARTED, successful or not. Null when none has ever run. */
  sinceLastAttemptMinutes: number | null;
  /** A run is started, unfinished, and recent enough to still be believable. */
  inFlight: boolean;
}

/**
 * The gate order, as a pure function.
 *
 * Order is the design here, and every step of it is load-bearing:
 *
 *  1. **in-flight** first, so a running sync is never joined by a second one.
 *  2. **never-run** next, because the first sync is a full backfill (~8 min for Skio alone) and
 *     a page view must not start one.
 *  3. **cooldown** before staleness. This is the one that is easy to get backwards: a broken
 *     source stays stale forever, so checking staleness first would retry on every page view
 *     indefinitely, billing a third-party API each time. The cooldown keys off the last
 *     ATTEMPT rather than the last success for the same reason.
 *  4. **staleness** last — the only gate that says "yes".
 */
export function decideRefresh(f: RefreshFacts): RefreshDecision {
  if (f.inFlight) {
    return {
      refresh: false,
      blockedBy: "in-flight",
      reason: "A sync is already running.",
      ageMinutes: f.ageMinutes,
    };
  }

  if (f.sinceLastAttemptMinutes === null) {
    return {
      refresh: false,
      blockedBy: "never-synced-manually",
      reason:
        "No sync has ever run. The first one is a full backfill and should be started " +
        "deliberately — double-click UPDATE DATA, or run the backfill script.",
      ageMinutes: f.ageMinutes,
    };
  }

  if (f.sinceLastAttemptMinutes < COOLDOWN_MINUTES) {
    return {
      refresh: false,
      blockedBy: "cooldown",
      reason: `Last attempt was ${Math.round(f.sinceLastAttemptMinutes)} min ago; waiting for the ${COOLDOWN_MINUTES} min cooldown.`,
      ageMinutes: f.ageMinutes,
    };
  }

  if (f.ageMinutes !== null && f.ageMinutes < STALE_AFTER_MINUTES) {
    return {
      refresh: false,
      blockedBy: "fresh",
      reason: `Data is ${Math.round(f.ageMinutes)} min old, under the ${STALE_AFTER_MINUTES} min threshold.`,
      ageMinutes: f.ageMinutes,
    };
  }

  return {
    refresh: true,
    reason:
      f.ageMinutes === null
        ? "No sync has ever completed."
        : `Data is ${Math.round(f.ageMinutes)} min old.`,
    ageMinutes: f.ageMinutes,
  };
}

export interface RefreshState {
  decision: RefreshDecision;
  /** When the most recent run of any source finished. Null when nothing has ever completed. */
  lastFinishedAt: string | null;
  /** True while a run is in flight, so the UI can say "refreshing" rather than "stale". */
  inFlight: boolean;
}

/**
 * Whether an automatic refresh should start.
 *
 * Deliberately makes no changes and takes no lock — it answers a question. The caller takes
 * the lock by starting a run, which is what makes gate 3 real rather than advisory.
 */
export async function getRefreshState(): Promise<RefreshState> {
  const rows = await db.execute<{
    last_finished: string | null;
    last_started: string | null;
    in_flight: boolean;
    age_minutes: number | null;
    since_last_attempt: number | null;
  }>(sql`
    SELECT
      max(finished_at)::text                                            AS last_finished,
      max(started_at)::text                                             AS last_started,
      -- In flight: started, not finished, and recent enough to still be believable.
      COALESCE(bool_or(
        finished_at IS NULL
        AND started_at > now() - (${IN_FLIGHT_TTL_MINUTES} || ' minutes')::interval
      ), false)                                                          AS in_flight,
      EXTRACT(EPOCH FROM (now() - max(finished_at))) / 60                AS age_minutes,
      -- Cooldown counts from the last ATTEMPT, not the last success. A failing source never
      -- produces a success, so keying the cooldown on success would never close this gate.
      EXTRACT(EPOCH FROM (now() - max(started_at))) / 60                 AS since_last_attempt
    FROM sync_runs
  `);

  const r = [...rows][0];
  const lastFinishedAt = r?.last_finished ?? null;
  const inFlight = Boolean(r?.in_flight);
  const ageMinutes = r?.age_minutes === null || r?.age_minutes === undefined
    ? null
    : Number(r.age_minutes);
  // Null when nothing has ever started, which is what the never-run gate keys on. Distinct
  // from zero, which would mean "a run started this instant".
  const sinceAttempt =
    r?.last_started == null || r?.since_last_attempt == null
      ? null
      : Number(r.since_last_attempt);

  return {
    lastFinishedAt,
    inFlight,
    decision: decideRefresh({ ageMinutes, sinceLastAttemptMinutes: sinceAttempt, inFlight }),
  };
}

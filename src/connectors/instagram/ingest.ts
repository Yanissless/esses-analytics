/**
 * Writes Instagram follower data into `social_audience`.
 *
 * Two kinds of row come out of one sync, and the distinction is the whole design:
 *
 *  - **Today's total is exact.** `followers_count` is the real number, so today's row is a
 *    genuine observation and needs no arithmetic.
 *  - **The preceding ~29 days are reconstructed** by walking `follower_count` deltas back
 *    from that total, because Meta publishes no dated historical total.
 *
 * So a reconstructed row NEVER overwrites an observation. On the first sync the whole 30-day
 * window is derived; after that each day contributes one exact reading and the series becomes
 * progressively all-observed. Overwriting yesterday's exact reading with today's derived
 * estimate of it would quietly degrade the series every single night — the sort of slow
 * corruption nothing alerts on.
 *
 * Rows already carrying `manual` or `csv` are also left alone: a number a human read off the
 * app is an observation too, and the reconstruction has no more claim on that day than they do.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { logger } from "../../lib/logger";
import { reconstructTotals } from "../../metrics/audience-growth";
import { getFollowerDeltas, getInstagramAccount } from "./client";

/** Sources that represent a real reading and must not be replaced by a derived one. */
const OBSERVED = ["meta_api", "manual", "csv"] as const;

export interface InstagramSyncResult {
  accountId: string | null;
  username: string | null;
  followersNow: number | null;
  /** Rows written as exact observations (today). */
  observedWritten: number;
  /** Rows written as reconstructed history. */
  reconstructedWritten: number;
  /** Days skipped because an observation already existed. */
  skippedObserved: number;
  warnings: string[];
}

export async function syncInstagramAudience(): Promise<InstagramSyncResult> {
  const warnings: string[] = [];
  const account = await getInstagramAccount();

  if (!account) {
    warnings.push(
      "No Instagram business account is linked to any visible Page. Link the account to the " +
        "Page in Meta Business Settings, or run `run.cmd check:meta` to see what is visible.",
    );
    return {
      accountId: null,
      username: null,
      followersNow: null,
      observedWritten: 0,
      reconstructedWritten: 0,
      skippedObserved: 0,
      warnings,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const deltas = await getFollowerDeltas();
  if (deltas.length === 0) {
    warnings.push(
      "follower_count returned no daily values, so only today's total was recorded. Meta " +
        "supplies this insight over a rolling ~30-day window and it can be empty on a new " +
        "or low-activity account.",
    );
  }

  // Today's exact reading first, so it exists even if the reconstruction produces nothing.
  const observed = await upsert(
    [{ date: today, followers: account.followersCount }],
    "meta_api",
    `followers_count read from the Graph API for @${account.username ?? account.id}`,
    false,
  );

  // Then the derived history, never overwriting a day that already has a real reading.
  const history = reconstructTotals(deltas, account.followersCount, today).filter(
    (r) => r.date !== today,
  );
  const derived = await upsert(
    history,
    "meta_export",
    `reconstructed from follower_count deltas; anchored ${account.followersCount} on ${today}`,
    true,
  );

  logger.info("instagram audience sync done", {
    account: account.username ?? account.id,
    followersNow: account.followersCount,
    observed: observed.written,
    reconstructed: derived.written,
    skipped: derived.skipped,
  });

  return {
    accountId: account.id,
    username: account.username,
    followersNow: account.followersCount,
    observedWritten: observed.written,
    reconstructedWritten: derived.written,
    skippedObserved: derived.skipped,
    warnings,
  };
}

/**
 * Upserts rows, optionally refusing to replace an existing observation.
 *
 * `protectObserved` drives a `WHERE` on the conflict update: with it set, a derived row only
 * lands on a day that is empty or already derived. Doing this in SQL rather than by reading
 * first means two syncs racing cannot both decide a day is free.
 */
async function upsert(
  rows: Array<{ date: string; followers: number }>,
  source: string,
  note: string,
  protectObserved: boolean,
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  for (const r of rows) {
    const res = await db.execute(sql`
      INSERT INTO social_audience (platform, captured_on, followers, source, note)
      VALUES ('instagram', ${r.date}, ${r.followers}, ${source}, ${note})
      ON CONFLICT (platform, captured_on) DO UPDATE SET
        followers  = EXCLUDED.followers,
        source     = EXCLUDED.source,
        note       = EXCLUDED.note,
        updated_at = now()
      ${
        protectObserved
          ? sql`WHERE social_audience.source NOT IN (${sql.join(
              OBSERVED.map((s) => sql`${s}`),
              sql`, `,
            )})`
          : sql``
      }
    `);
    // postgres.js reports affected rows on the result; treat an unknown shape as written.
    const affected = (res as unknown as { count?: number }).count;
    if (affected === 0) continue;
    written += 1;
  }
  return { written, skipped: rows.length - written };
}

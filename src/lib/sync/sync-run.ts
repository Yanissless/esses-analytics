/**
 * Sync-run lifecycle logging (Section 6/14). Every connector run is wrapped by
 * `withSyncRun`, which writes a `sync_runs` row, records rows in/upserted and a
 * resume cursor, and on failure marks the run failed AND fires a loud alert.
 *
 * Relative imports so this is safe to call from both Next API routes and
 * standalone tsx cron scripts.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { syncRuns } from "../../db/schema";
import { logger } from "../logger";
import type { ConnectorSource, SyncResult, SyncWindow } from "../../connectors/types";

type Mode = "backfill" | "incremental";

export async function startSyncRun(
  source: ConnectorSource,
  mode: Mode,
  window?: SyncWindow,
): Promise<string> {
  const [row] = await db
    .insert(syncRuns)
    .values({
      source,
      mode,
      status: "running",
      windowSince: window?.since,
      windowUntil: window?.until,
    })
    .returning({ id: syncRuns.id });
  return row.id;
}

export async function finishSyncRun(
  runId: string,
  result: Pick<SyncResult, "rowsIn" | "rowsUpserted" | "cursor" | "warnings">,
): Promise<void> {
  const status = result.warnings.length > 0 ? "partial" : "success";
  await db
    .update(syncRuns)
    .set({
      status,
      finishedAt: new Date(),
      rowsIn: result.rowsIn,
      rowsUpserted: result.rowsUpserted,
      cursor: result.cursor,
      warnings: result.warnings.length ? result.warnings : null,
    })
    .where(eq(syncRuns.id, runId));
}

export async function failSyncRun(runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(syncRuns)
    .set({ status: "failed", finishedAt: new Date(), error: message })
    .where(eq(syncRuns.id, runId));
}

/**
 * Run a connector sync inside a logged, alert-on-failure envelope.
 * The callback returns a SyncResult; this handles all the bookkeeping.
 */
export async function withSyncRun(
  source: ConnectorSource,
  mode: Mode,
  fn: () => Promise<SyncResult>,
  window?: SyncWindow,
): Promise<SyncResult> {
  const runId = await startSyncRun(source, mode, window);
  try {
    const result = await fn();
    await finishSyncRun(runId, result);
    logger.info(`sync ${source}/${mode} ok`, {
      runId,
      rowsIn: result.rowsIn,
      rowsUpserted: result.rowsUpserted,
    });
    return result;
  } catch (error) {
    await failSyncRun(runId, error);
    await logger.alert(`sync ${source}/${mode} FAILED`, {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

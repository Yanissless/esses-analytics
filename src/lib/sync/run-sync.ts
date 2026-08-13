/**
 * The incremental-sync orchestration, shared by the `sync` CLI and the cron API route.
 *
 * Extracted from `scripts/sync.ts` so a scheduled deployment and a developer's terminal
 * run exactly the same code. Duplicating it would have been the fourth instance of the
 * copy-paste-then-drift pattern this codebase has already been bitten by twice
 * (`revenue_class`, the rate-rule predicate).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { syncRuns } from "../../db/schema";
import { connectorConfigured } from "../env";
import { logger } from "../logger";
import { withSyncRun } from "./sync-run";
import { shopifyConnector } from "../../connectors/shopify";
import { skioConnector } from "../../connectors/skio";
import { stripeConnector } from "../../connectors/stripe";
import { AD_PLATFORMS, asConnector } from "../../connectors/ads";
import { syncInstagramAudience, syncInstagramInsights } from "../../connectors/instagram/ingest";
import { rebuildDailyMetrics } from "../../metrics/rollup";
import type { Connector } from "../../connectors/types";

export const ALL_SYNC_SOURCES = ["shopify", "skio", "stripe", "ads", "instagram"] as const;

export interface SourceResult {
  source: string;
  ok: boolean;
  rows?: number;
  error?: string;
  skipped?: boolean;
}

export interface SyncSummary {
  results: SourceResult[];
  metricsDays: number | null;
  failed: string[];
  ok: boolean;
  ms: number;
}

/**
 * Statuses whose cursor can be trusted.
 *
 * **`partial` counts, and leaving it out was a real bug.** `finishSyncRun` marks a run partial
 * whenever it carries any warning, and Shopify carries a permanent one: shipping label costs
 * need the `read_reports` scope we do not have. Orders themselves sync perfectly. But with
 * only `success` accepted, that one standing warning meant Shopify's cursor never advanced
 * past 29 July 2026 — every subsequent sync re-fetched a fortnight of orders, and the window
 * grew by a day every day.
 *
 * It was invisible because the data was RIGHT: re-fetching everything produces correct orders,
 * just slowly. What it looked like was "sync is getting slower", plus a freshness display that
 * would have reported Shopify as fifteen days stale while it was in fact current.
 *
 * A warning is not a failure. A partial run ingested its rows and recorded a real cursor; only
 * a `failed` run has a cursor that cannot be trusted.
 */
const CURSOR_TRUSTED_STATUSES = ["success", "partial"] as const;

async function lastCursor(source: string): Promise<string | undefined> {
  const [row] = await db
    .select({ cursor: syncRuns.cursor })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.source, source),
        inArray(syncRuns.status, [...CURSOR_TRUSTED_STATUSES]),
      ),
    )
    .orderBy(desc(syncRuns.finishedAt))
    .limit(1);
  return row?.cursor ?? undefined;
}

/**
 * Run one source. Failures are CONTAINED: a network blip on one platform must not stop
 * the others — an early version aborted the whole script when Skio dropped a connection,
 * so Stripe never ran. The failure is still recorded by withSyncRun and alerted on.
 */
async function runIncremental(
  connector: Connector,
  configured: boolean,
): Promise<SourceResult> {
  if (!configured) {
    logger.warn(`${connector.source} not configured — skipping`);
    return { source: connector.source, ok: true, rows: 0, skipped: true };
  }
  const cursor = await lastCursor(connector.source);
  try {
    const r = await withSyncRun(connector.source, "incremental", () =>
      connector.incrementalSync(cursor),
    );
    logger.info(`${connector.source} sync done`, {
      rows: r.rowsUpserted,
      since: cursor ?? "24h",
    });
    return { source: connector.source, ok: true, rows: r.rowsUpserted };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`${connector.source} sync failed — continuing with other sources`, { error });
    return { source: connector.source, ok: false, error };
  }
}

/**
 * Instagram audience, wrapped to match `runIncremental`'s contract.
 *
 * Not a `Connector`: there is no cursor to advance and nothing incremental about it — every
 * run asks Meta for the same rolling 30-day window and writes what it gets. Forcing it into
 * the Connector interface would have meant a meaningless `incrementalSync(cursor)` that
 * ignores its argument.
 */
async function runInstagram(configured: boolean): Promise<SourceResult> {
  if (!configured) {
    logger.warn("instagram not configured — skipping");
    return { source: "instagram", ok: true, rows: 0, skipped: true };
  }
  try {
    const r = await withSyncRun("instagram", "incremental", async () => {
      const s = await syncInstagramAudience();
      // Default window (2 days) — reach settles over ~24h, so yesterday gets re-fetched.
      const i = await syncInstagramInsights();
      const written = s.observedWritten + s.reconstructedWritten + i.daysWritten;
      return {
        source: "instagram" as const,
        // rowsIn counts what Meta gave us; skipped days are read but deliberately not written.
        rowsIn: written + s.skippedObserved,
        rowsUpserted: written,
        warnings: [...s.warnings, ...i.unavailable.map((u) => `${u.metric}: ${u.reason}`)],
      };
    });
    logger.info("instagram sync done", { rows: r.rowsUpserted });
    return { source: "instagram", ok: true, rows: r.rowsUpserted };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("instagram sync failed — continuing with other sources", { error });
    return { source: "instagram", ok: false, error };
  }
}

/**
 * Sync the requested sources, then refresh the rollup.
 *
 * The rollup runs LAST and runs even when a source failed: partial-but-current beats
 * stale. It also must run at all — `order_profit` is materialised, and skipping the
 * rebuild after new orders land makes `/international` silently under-report.
 */
export async function runSync(
  opts: { sources?: string[]; skipMetrics?: boolean } = {},
): Promise<SyncSummary> {
  const started = Date.now();
  const sources = opts.sources?.length ? opts.sources : [...ALL_SYNC_SOURCES];
  const results: SourceResult[] = [];

  if (sources.includes("shopify")) {
    results.push(await runIncremental(shopifyConnector, connectorConfigured.shopify()));
  }
  if (sources.includes("skio")) {
    results.push(await runIncremental(skioConnector, connectorConfigured.skio()));
  }
  if (sources.includes("stripe")) {
    results.push(await runIncremental(stripeConnector, connectorConfigured.stripe()));
  }
  // Ad platforms come from the registry, so a new one needs no change here.
  for (const p of AD_PLATFORMS) {
    if (!sources.includes(p.platform) && !sources.includes("ads")) continue;
    results.push(await runIncremental(asConnector(p), p.isConfigured()));
  }

  /**
   * Instagram organic is in the nightly run because missing a night costs data permanently.
   *
   * Meta serves `follower_count` over a rolling 30-day window and publishes no dated
   * historical total at all, so a day that is never recorded can only ever be reconstructed
   * from deltas — and once it falls out of that window it cannot be recovered by any means.
   * Unlike Shopify or Stripe, where a missed night is caught up by the next cursor, this one
   * is lossy. It runs last and its failure is contained like every other source.
   */
  if (sources.includes("instagram")) {
    results.push(await runInstagram(connectorConfigured.instagram()));
  }

  let metricsDays: number | null = null;
  if (!opts.skipMetrics) {
    try {
      const m = await rebuildDailyMetrics();
      metricsDays = m.daysComputed;
      logger.info("Metrics rollup refreshed", { days: m.daysComputed });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("Metrics rollup failed", { error });
      results.push({ source: "metrics", ok: false, error });
    }
  }

  const failed = results.filter((r) => !r.ok).map((r) => r.source);
  const summary: SyncSummary = {
    results,
    metricsDays,
    failed,
    ok: failed.length === 0,
    ms: Date.now() - started,
  };

  logger.info("Sync complete", {
    ok: results.filter((r) => r.ok).map((r) => `${r.source}:${r.rows ?? 0}`),
    failed,
    ms: summary.ms,
  });

  return summary;
}

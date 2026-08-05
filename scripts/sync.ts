/**
 * Incremental sync (Section 3). Catches up each source since its last successful
 * run's cursor, wrapped in withSyncRun. Intended to run on a schedule (cron/queue).
 *
 *   pnpm sync                     # both
 *   pnpm sync --source=stripe     # one source
 */
import "dotenv/config";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { syncRuns } from "../src/db/schema";
import { connectorConfigured } from "../src/lib/env";
import { logger } from "../src/lib/logger";
import { withSyncRun } from "../src/lib/sync/sync-run";
import { shopifyConnector } from "../src/connectors/shopify";
import { skioConnector } from "../src/connectors/skio";
import { stripeConnector } from "../src/connectors/stripe";
import { AD_PLATFORMS, asConnector } from "../src/connectors/ads";
import { rebuildDailyMetrics } from "../src/metrics/rollup";
import type { Connector } from "../src/connectors/types";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function lastCursor(source: string): Promise<string | undefined> {
  const [row] = await db
    .select({ cursor: syncRuns.cursor })
    .from(syncRuns)
    .where(and(eq(syncRuns.source, source), eq(syncRuns.status, "success")))
    .orderBy(desc(syncRuns.finishedAt))
    .limit(1);
  return row?.cursor ?? undefined;
}

/**
 * Run one source. Failures are CONTAINED: a network blip on one platform must not
 * stop the others (an early version aborted the whole script when Skio dropped a
 * connection, so Stripe never ran). The failure is still recorded by withSyncRun
 * and alerted on; we just keep going and report a non-zero exit at the end.
 */
async function runIncremental(
  connector: Connector,
  configured: boolean,
): Promise<{ source: string; ok: boolean; rows?: number; error?: string }> {
  if (!configured) {
    logger.warn(`${connector.source} not configured — skipping`);
    return { source: connector.source, ok: true, rows: 0 };
  }
  const cursor = await lastCursor(connector.source);
  try {
    const r = await withSyncRun(connector.source, "incremental", () =>
      connector.incrementalSync(cursor),
    );
    logger.info(`${connector.source} sync done`, { rows: r.rowsUpserted, since: cursor ?? "24h" });
    return { source: connector.source, ok: true, rows: r.rowsUpserted };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`${connector.source} sync failed — continuing with other sources`, { error });
    return { source: connector.source, ok: false, error };
  }
}

async function main() {
  const sources = (arg("source") ?? "shopify,skio,stripe,ads")
    .split(",")
    .map((s) => s.trim());

  const results: Array<{ source: string; ok: boolean; rows?: number; error?: string }> = [];

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

  // Refresh the rollup last, so the dashboard reflects whatever synced. Runs even
  // if a source failed — partial-but-current beats stale.
  if (!arg("skip-metrics")) {
    try {
      const m = await rebuildDailyMetrics();
      logger.info("Metrics rollup refreshed", { days: m.daysComputed });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("Metrics rollup failed", { error });
      results.push({ source: "metrics", ok: false, error });
    }
  }

  const failed = results.filter((r) => !r.ok);
  logger.info("Sync complete", {
    ok: results.filter((r) => r.ok).map((r) => `${r.source}:${r.rows ?? 0}`),
    failed: failed.map((r) => r.source),
  });

  // Non-zero exit so a scheduler notices, even though we ran everything we could.
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f.source}: ${f.error}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    logger.error("Sync failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

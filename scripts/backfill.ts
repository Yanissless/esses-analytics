/**
 * Historical backfill (Section 4). Loads Shopify + Stripe from a start date
 * (default 2025-01-01) into the same schema, each wrapped in withSyncRun so the
 * run is logged and a failure fires an alert.
 *
 *   pnpm backfill                        # both, since 2025-01-01
 *   pnpm backfill --since=2025-09-01     # both, since a date
 *   pnpm backfill --source=shopify       # one source
 */
import "dotenv/config";
import { connectorConfigured } from "../src/lib/env";
import { logger } from "../src/lib/logger";
import { withSyncRun } from "../src/lib/sync/sync-run";
import { shopifyConnector } from "../src/connectors/shopify";
import { skioConnector } from "../src/connectors/skio";
import { stripeConnector } from "../src/connectors/stripe";
import { AD_PLATFORMS, asConnector } from "../src/connectors/ads";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main() {
  const since = new Date(arg("since") ?? "2025-01-01T00:00:00Z");
  if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since date`);
  const sources = (arg("source") ?? "shopify,skio,stripe,ads")
    .split(",")
    .map((s) => s.trim());
  const window = { since };

  logger.info(`Backfill since ${since.toISOString()} for: ${sources.join(", ")}`);

  if (sources.includes("shopify")) {
    if (!connectorConfigured.shopify()) {
      logger.warn("Shopify not configured (SHOPIFY_* env) — skipping");
    } else {
      const r = await withSyncRun("shopify", "backfill", () => shopifyConnector.backfill(window), window);
      logger.info("Shopify backfill done", { rows: r.rowsUpserted });
    }
  }

  // Skio runs after Shopify so the orders it links to already exist.
  if (sources.includes("skio")) {
    if (!connectorConfigured.skio()) {
      logger.warn("Skio not configured (SKIO_API_KEY) — skipping");
    } else {
      const r = await withSyncRun("skio", "backfill", () => skioConnector.backfill(window), window);
      logger.info("Skio backfill done", { rows: r.rowsUpserted });
    }
  }

  if (sources.includes("stripe")) {
    if (!connectorConfigured.stripe()) {
      logger.warn("Stripe not configured (STRIPE_SECRET_KEY) — skipping");
    } else {
      const r = await withSyncRun("stripe", "backfill", () => stripeConnector.backfill(window), window);
      logger.info("Stripe backfill done", { rows: r.rowsUpserted });
    }
  }

  for (const p of AD_PLATFORMS) {
    if (!sources.includes(p.platform) && !sources.includes("ads")) continue;
    if (!p.isConfigured()) {
      logger.warn(`${p.label} not configured — skipping`);
      continue;
    }
    const c = asConnector(p);
    const r = await withSyncRun(c.source, "backfill", () => c.backfill(window), window);
    logger.info(`${p.label} backfill done`, { rows: r.rowsUpserted });
  }

  logger.info("Backfill complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("Backfill failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

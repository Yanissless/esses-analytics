/**
 * Skio connector — enrichment layer over Shopify orders. Loads subscriptions into
 * `subscription_meta` and links Shopify subscription orders to them. Must run AFTER the
 * Shopify backfill so the orders exist to link.
 *
 * ## Incremental is now genuinely incremental
 *
 * `incrementalSync` used to call the same unfiltered loader as `backfill`, walking all 3,935
 * subscriptions on every run. Measured: **479 seconds**. It was named incremental and was a
 * full load, and nothing in the code or the logs said so.
 *
 * That would have broken the deployed nightly cron on day one. Vercel's ceiling is 300s even
 * on Pro, so the function would have been killed mid-write every night — and because the kill
 * comes from outside the process, `withSyncRun` never gets to record a failure. A silent,
 * permanent, nightly half-sync.
 *
 * It now filters on `updatedAt`: ~794 subscriptions for a one-day window against 3,935 for the
 * full set, so about a fifth of the work.
 *
 * `updatedAt` and NOT `createdAt` — a subscription that cancels or changes plan keeps its
 * creation date, so a createdAt filter would miss exactly the changes worth syncing. In the
 * last week 2,710 subscriptions were updated against 293 created.
 */
import { connectorConfigured } from "../../lib/env";
import { logger } from "../../lib/logger";
import type { Connector, SyncResult } from "../types";
import { skioGraphQL } from "./client";
import { SUBSCRIPTIONS_QUERY, SUBSCRIPTIONS_SINCE_QUERY } from "./queries";
import { ingestSkioSubscription, type SkioSubscriptionRaw } from "./ingest";

const PAGE = 100;

/**
 * How far back an incremental run looks, beyond the cursor.
 *
 * Guards one thing only: a subscription changing in the seconds between the query running and
 * the cursor being written. A few hours is ample for that.
 *
 * It was two DAYS at first, on the theory that a missed night should self-heal. That was both
 * unnecessary and expensive. Unnecessary because the cursor only advances on a run that
 * completed, so a missed night already widens the next window automatically. Expensive because
 * Skio's `updatedAt` clusters: a one-day window is ~794 subscriptions, a two-day window is
 * ~2,487 — three times the work for one extra day, which pushed a single run back over the
 * serverless ceiling the change was meant to get under.
 */
const OVERLAP_HOURS = 6;

/** Hard page cap. A paging bug that never returns a short page would otherwise loop forever. */
const MAX_PAGES = 200;

async function loadSubscriptions(since: Date | null): Promise<number> {
  const query = since ? SUBSCRIPTIONS_SINCE_QUERY : SUBSCRIPTIONS_QUERY;
  let offset = 0;
  let count = 0;
  let pages = 0;

  for (;;) {
    const vars: Record<string, unknown> = { limit: PAGE, offset };
    if (since) vars.since = since.toISOString();

    const data = await skioGraphQL<{ Subscriptions: SkioSubscriptionRaw[] }>(query, vars);
    const batch = data.Subscriptions ?? [];
    for (const sub of batch) {
      await ingestSkioSubscription(sub);
      count++;
    }
    pages++;
    if (batch.length < PAGE) break;
    if (pages >= MAX_PAGES) {
      logger.warn("Skio pagination cap hit — some subscriptions were not read", {
        pages,
        read: count,
      });
      break;
    }
    offset += PAGE;
  }

  logger.debug(`Skio subscriptions read: ${count} over ${pages} page(s)`, {
    since: since?.toISOString() ?? "all",
  });
  return count;
}

export const skioConnector: Connector = {
  source: "skio",

  isConfigured: () => connectorConfigured.skio(),

  async healthCheck() {
    if (!connectorConfigured.skio()) {
      return { ok: false, detail: "SKIO_API_KEY not set" };
    }
    try {
      await skioGraphQL(`query { Subscriptions(limit: 1) { id } }`);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },

  /** A full walk, deliberately. Operator-run, never scheduled. */
  async backfill(): Promise<SyncResult> {
    const rows = await loadSubscriptions(null);
    return {
      source: "skio",
      rowsIn: rows,
      rowsUpserted: rows,
      warnings: [],
      cursor: new Date().toISOString(),
    };
  },

  /**
   * Only subscriptions changed since the cursor, minus an overlap.
   *
   * With no usable cursor — a first run, or after `sync_runs` is cleared — it falls back to a
   * full load rather than inventing a window, because a guessed window would silently skip
   * every subscription older than the guess and nothing downstream could tell.
   */
  async incrementalSync(sinceCursor?: string): Promise<SyncResult> {
    const warnings: string[] = [];
    let since: Date | null = null;

    if (sinceCursor) {
      const parsed = new Date(sinceCursor);
      if (Number.isFinite(parsed.getTime())) {
        since = new Date(parsed.getTime() - OVERLAP_HOURS * 3600 * 1000);
      } else {
        warnings.push(
          `Ignoring unparseable cursor "${sinceCursor}" and reading all subscriptions.`,
        );
      }
    }

    if (!since) {
      warnings.push(
        "No usable cursor, so every subscription was read. Correct but slow (~8 min); " +
          "subsequent runs will be incremental.",
      );
    }

    const rows = await loadSubscriptions(since);
    return {
      source: "skio",
      rowsIn: rows,
      rowsUpserted: rows,
      warnings,
      cursor: new Date().toISOString(),
    };
  },
};

/**
 * Skio connector — enrichment layer over Shopify orders. Loads all subscriptions
 * (the set is small) into subscription_meta and links Shopify subscription orders
 * to them. Must run AFTER the Shopify backfill so the orders exist to link.
 */
import { connectorConfigured } from "../../lib/env";
import type { Connector, SyncResult } from "../types";
import { skioGraphQL } from "./client";
import { SUBSCRIPTIONS_QUERY } from "./queries";
import { ingestSkioSubscription, type SkioSubscriptionRaw } from "./ingest";

const PAGE = 100;

async function loadAllSubscriptions(): Promise<number> {
  let offset = 0;
  let count = 0;
  for (;;) {
    const data = await skioGraphQL<{ Subscriptions: SkioSubscriptionRaw[] }>(
      SUBSCRIPTIONS_QUERY,
      { limit: PAGE, offset },
    );
    const batch = data.Subscriptions ?? [];
    for (const sub of batch) {
      await ingestSkioSubscription(sub);
      count++;
    }
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
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

  async backfill(): Promise<SyncResult> {
    const rows = await loadAllSubscriptions();
    return { source: "skio", rowsIn: rows, rowsUpserted: rows, warnings: [], cursor: new Date().toISOString() };
  },

  async incrementalSync(): Promise<SyncResult> {
    const rows = await loadAllSubscriptions();
    return { source: "skio", rowsIn: rows, rowsUpserted: rows, warnings: [], cursor: new Date().toISOString() };
  },
};

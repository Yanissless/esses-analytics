/**
 * Stripe connector — implements the generic Connector contract. Backfill loads
 * all subscriptions (status "all") + invoices in a window; incremental re-lists
 * subscriptions (to catch status/churn changes) and invoices created since the
 * last watermark. Print/digital split handled in ingest.
 */
import { connectorConfigured } from "../../lib/env";
import type { Connector, SyncResult, SyncWindow } from "../types";
import { stripe } from "./client";
import { ingestInvoice, ingestSubscription } from "./ingest";

function createdFilter(window?: SyncWindow) {
  if (!window) return undefined;
  const range: { gte: number; lte?: number } = {
    gte: Math.floor(window.since.getTime() / 1000),
  };
  if (window.until) range.lte = Math.floor(window.until.getTime() / 1000);
  return range;
}

async function loadSubscriptions(created?: { gte: number; lte?: number }): Promise<number> {
  let count = 0;
  for await (const sub of stripe().subscriptions.list({
    limit: 100,
    status: "all",
    expand: ["data.customer"],
    ...(created ? { created } : {}),
  })) {
    await ingestSubscription(sub);
    count++;
  }
  return count;
}

async function loadInvoices(created?: { gte: number; lte?: number }): Promise<number> {
  let count = 0;
  for await (const inv of stripe().invoices.list({
    limit: 100,
    expand: ["data.customer"],
    ...(created ? { created } : {}),
  })) {
    await ingestInvoice(inv);
    count++;
  }
  return count;
}

export const stripeConnector: Connector = {
  source: "stripe",

  isConfigured: () => connectorConfigured.stripe(),

  async healthCheck() {
    if (!connectorConfigured.stripe()) {
      return { ok: false, detail: "STRIPE_SECRET_KEY not set" };
    }
    try {
      await stripe().balance.retrieve();
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },

  async backfill(window: SyncWindow): Promise<SyncResult> {
    const created = createdFilter(window);
    const subs = await loadSubscriptions(created);
    const invs = await loadInvoices(created);
    return {
      source: "stripe",
      rowsIn: subs + invs,
      rowsUpserted: subs + invs,
      warnings: [],
      cursor: new Date().toISOString(),
    };
  },

  async incrementalSync(sinceCursor?: string): Promise<SyncResult> {
    const since = sinceCursor ? new Date(sinceCursor) : new Date(Date.now() - 24 * 3600 * 1000);
    // Re-list all subscriptions to catch status/churn changes (volume is modest);
    // only pull invoices created since the watermark.
    const subs = await loadSubscriptions();
    const invs = await loadInvoices({ gte: Math.floor(since.getTime() / 1000) });
    return {
      source: "stripe",
      rowsIn: subs + invs,
      rowsUpserted: subs + invs,
      warnings: [],
      cursor: new Date().toISOString(),
    };
  },
};

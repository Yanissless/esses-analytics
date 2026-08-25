/**
 * Shopify connector — implements the generic Connector contract (backfill,
 * incremental, health). Orders are the source of truth for order revenue;
 * ingest.ts classifies each order for revenue recognition (Section 3).
 */
import { connectorConfigured } from "../../lib/env";
import type { Connector, SyncResult, SyncWindow } from "../types";
import { type Connection, paginate, shopifyGraphQL } from "./client";
import { ORDERS_QUERY, PRODUCTS_QUERY } from "./queries";
import {
  finalizeAcquisition,
  ingestOrder,
  type OrderNode,
  type ProductNode,
  upsertProduct,
} from "./ingest";
import { syncShippingLabelCosts } from "./shipping-costs";
import { stampAcquisitionChannels } from "../../attribution/ingest";
import { logger } from "../../lib/logger";

function toShopQueryDate(d: Date): string {
  // Shopify search accepts ISO-8601; keep it simple and unambiguous.
  return d.toISOString();
}

function orderFilter(field: string, window?: SyncWindow): string | null {
  if (!window) return null;
  const parts = [`${field}:>=${toShopQueryDate(window.since)}`];
  if (window.until) parts.push(`${field}:<=${toShopQueryDate(window.until)}`);
  return parts.join(" ");
}

async function ingestAllProducts(): Promise<number> {
  let rows = 0;
  for await (const node of paginate<ProductNode, { products: Connection<ProductNode> }>(
    (after) => ({ query: PRODUCTS_QUERY, variables: { first: 50, after } }),
    (data) => data.products,
  )) {
    rows += await upsertProduct(node);
  }
  return rows;
}

async function ingestOrders(
  filter: string | null,
  sortKey: "PROCESSED_AT" | "UPDATED_AT",
): Promise<number> {
  let count = 0;
  for await (const node of paginate<OrderNode, { orders: Connection<OrderNode> }>(
    (after) => ({
      query: ORDERS_QUERY,
      variables: { first: 50, after, query: filter, sortKey },
    }),
    (data) => data.orders,
  )) {
    await ingestOrder(node);
    count++;
  }
  return count;
}

export const shopifyConnector: Connector = {
  source: "shopify",

  isConfigured: () => connectorConfigured.shopify(),

  async healthCheck() {
    if (!connectorConfigured.shopify()) {
      return { ok: false, detail: "SHOPIFY_SHOP / SHOPIFY_ADMIN_ACCESS_TOKEN not set" };
    }
    try {
      await shopifyGraphQL<{ shop: { name: string } }>(`{ shop { name } }`);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },

  async backfill(window: SyncWindow): Promise<SyncResult> {
    const productRows = await ingestAllProducts();
    const orderRows = await ingestOrders(orderFilter("processed_at", window), "PROCESSED_AT");
    await finalizeAcquisition();
    await stampAcquisitionChannels();
    const ship = await syncLabelCosts(window.since, window.until ?? new Date());
    return {
      source: "shopify",
      rowsIn: productRows + orderRows + ship.labels,
      rowsUpserted: productRows + orderRows + ship.matched,
      warnings: ship.warnings,
      cursor: new Date().toISOString(),
    };
  },

  async incrementalSync(sinceCursor?: string): Promise<SyncResult> {
    const since = sinceCursor ? new Date(sinceCursor) : new Date(Date.now() - 24 * 3600 * 1000);
    const productRows = await ingestAllProducts(); // catalog is small; refresh fully
    const orderRows = await ingestOrders(orderFilter("updated_at", { since }), "UPDATED_AT");
    await finalizeAcquisition();
    await stampAcquisitionChannels();
    // Labels are often bought a few days after the order, so always re-pull the
    // trailing month rather than only since the cursor.
    const shipSince = new Date(Math.min(since.getTime(), Date.now() - 31 * 24 * 3600 * 1000));
    const ship = await syncLabelCosts(shipSince, new Date());
    return {
      source: "shopify",
      rowsIn: productRows + orderRows + ship.labels,
      rowsUpserted: productRows + orderRows + ship.matched,
      warnings: ship.warnings,
      cursor: new Date().toISOString(),
    };
  },
};

/**
 * Label costs come from the analytics layer (ShopifyQL), which needs the
 * `read_reports` scope. If that scope is missing the rest of the sync must still
 * succeed — shipping simply falls back to rate-rule estimates — so this is
 * deliberately non-fatal and surfaces as a warning instead.
 */
async function syncLabelCosts(
  since: Date,
  until: Date,
): Promise<{ labels: number; matched: number; warnings: string[] }> {
  try {
    const r = await syncShippingLabelCosts(since, until);
    logger.info("Shipping label costs synced", {
      labels: r.labels,
      matched: r.matched,
      attributedCents: r.attributedCents,
      ratesRefreshed: r.ratesRefreshed,
    });
    // Cap warnings first: an incomplete cost figure matters more than an unmatched label,
    // because the unmatched case is visible in the invoice allocation total and this one is not.
    const warnings: string[] = [...r.warnings];
    if (r.unmatched > 0) {
      warnings.push(`${r.unmatched} shipping label(s) had no matching order in range`);
    }
    return { labels: r.labels, matched: r.matched, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("Shipping label cost sync skipped", { error: msg });
    return {
      labels: 0,
      matched: 0,
      warnings: [`shipping label costs unavailable (needs read_reports scope?): ${msg}`],
    };
  }
}

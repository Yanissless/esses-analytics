/**
 * Ingest a Shopify Bulk Operation JSONL export of orders.
 *
 * Bulk JSONL flattens nested connections: each Order is one line (no __parentId);
 * each LineItem/Refund is its own line carrying `__parentId` = the order's gid.
 * We reassemble orders with their line items, then feed each through the same
 * ingestOrder path the API connector uses (so revenue classification, customer
 * unification, and dedup all apply identically).
 *
 *   tsx scripts/ingest-bulk-jsonl.ts --file="C:\path\bulk-orders.jsonl"
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  finalizeAcquisition,
  ingestOrder,
  type OrderNode,
} from "../src/connectors/shopify/ingest";
import { logger } from "../src/lib/logger";
import { withSyncRun } from "../src/lib/sync/sync-run";

interface RawLine {
  id: string;
  __parentId?: string;
  refunds?: unknown;
  [k: string]: unknown;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main() {
  const file = arg("file") ?? process.argv[2];
  if (!file) throw new Error('Usage: tsx scripts/ingest-bulk-jsonl.ts --file="path/bulk-orders.jsonl"');

  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawLine);

  // Pass 1: order shells (lines with no parent). Pass 2: attach children.
  const orders = new Map<string, Record<string, unknown>>();
  const children: RawLine[] = [];
  for (const l of lines) {
    if (!l.__parentId) {
      orders.set(l.id, {
        ...l,
        lineItems: { edges: [] as Array<{ node: RawLine }> },
        refunds: Array.isArray(l.refunds) ? l.refunds : [],
      });
    } else {
      children.push(l);
    }
  }
  for (const c of children) {
    const parent = orders.get(c.__parentId as string) as
      | { lineItems: { edges: Array<{ node: RawLine }> }; refunds: unknown[] }
      | undefined;
    if (!parent) continue;
    if (c.id.includes("/LineItem/")) parent.lineItems.edges.push({ node: c });
    else if (c.id.includes("/Refund/")) parent.refunds.push(c);
  }

  logger.info(`Parsed ${orders.size} orders from ${lines.length} JSONL lines`);

  const result = await withSyncRun("shopify", "backfill", async () => {
    let n = 0;
    for (const node of orders.values()) {
      await ingestOrder(node as unknown as OrderNode);
      n++;
    }
    await finalizeAcquisition();
    return { source: "shopify" as const, rowsIn: orders.size, rowsUpserted: n, warnings: [] };
  });

  logger.info("Bulk JSONL ingest done", { orders: result.rowsUpserted });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("Bulk ingest failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

/**
 * Ingest a Shopify Bulk Operation JSONL export of products + variants.
 *
 * Bulk JSONL emits each Product as a parent line and each ProductVariant as a
 * child line carrying `__parentId`. We reassemble and feed them through the same
 * upsertProduct path the API connector uses.
 *
 * Products/variants matter for COGS: many order line items carry no SKU, so the
 * variant link is the fallback key for attaching a unit cost.
 *
 *   tsx scripts/ingest-bulk-products.ts --file="C:\path\bulk-products.jsonl"
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { upsertProduct, type ProductNode } from "../src/connectors/shopify/ingest";
import { logger } from "../src/lib/logger";
import { withSyncRun } from "../src/lib/sync/sync-run";

interface RawLine {
  id: string;
  __parentId?: string;
  [k: string]: unknown;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main() {
  const file = arg("file") ?? process.argv[2];
  if (!file) throw new Error('Usage: tsx scripts/ingest-bulk-products.ts --file="path/bulk-products.jsonl"');

  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawLine);

  const products = new Map<string, Record<string, unknown>>();
  const children: RawLine[] = [];
  for (const l of lines) {
    if (!l.__parentId) {
      products.set(l.id, { ...l, variants: { edges: [] as Array<{ node: RawLine }> } });
    } else {
      children.push(l);
    }
  }
  for (const c of children) {
    const parent = products.get(c.__parentId as string) as
      | { variants: { edges: Array<{ node: RawLine }> } }
      | undefined;
    if (parent && c.id.includes("/ProductVariant/")) {
      parent.variants.edges.push({ node: c });
    }
  }

  logger.info(`Parsed ${products.size} products from ${lines.length} JSONL lines`);

  const result = await withSyncRun("shopify", "backfill", async () => {
    let rows = 0;
    for (const p of products.values()) {
      rows += await upsertProduct(p as unknown as ProductNode);
    }
    return { source: "shopify" as const, rowsIn: products.size, rowsUpserted: rows, warnings: [] };
  });

  logger.info("Product ingest done", { rows: result.rowsUpserted });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("Product ingest failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

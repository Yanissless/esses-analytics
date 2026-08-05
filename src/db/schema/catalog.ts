import {
  date,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, money, pk, timestamps } from "./_shared";
import { costSource } from "./enums";

export const products = pgTable(
  "products",
  {
    id: pk(),
    shopifyProductId: text("shopify_product_id"),
    title: text("title"),
    handle: text("handle"),
    productType: text("product_type"),
    vendor: text("vendor"),
    status: text("status"),
    ...timestamps,
  },
  (t) => [uniqueIndex("products_shopify_id_unique").on(t.shopifyProductId)],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: pk(),
    productId: uuid("product_id").references(() => products.id),
    shopifyVariantId: text("shopify_variant_id"),
    sku: text("sku"),
    title: text("title"),
    priceAmount: money("price_amount"),
    currency: currency(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("variants_shopify_id_unique").on(t.shopifyVariantId),
    index("variants_sku_idx").on(t.sku),
  ],
);

/**
 * Per-unit product costs (Section 5) — the one manually-maintained table.
 *
 * Time-versioned: margin history uses the cost that was effective at the time of
 * each order, not today's cost. To resolve a cost for an order line, take the row
 * matching its SKU + fulfilment origin with the greatest `effective_date` <= the
 * order date.
 *
 * `origin` exists because the same issue costs different amounts depending on
 * where it was printed/fulfilled — US distribution vs the UK printer park that
 * serves UK/EU. Destination → origin routing lives in `market_config`; use origin
 * `'default'` for a cost that applies regardless of origin.
 *
 * Keyed by SKU (the stable business key); `variant_id` is a convenience link and
 * a fallback key for line items that carry no SKU.
 */
export const productCosts = pgTable(
  "product_costs",
  {
    id: pk(),
    sku: text("sku").notNull(),
    /** Fulfilment origin: 'US' | 'UK' | 'default'. */
    origin: text("origin").notNull().default("default"),
    variantId: uuid("variant_id").references(() => productVariants.id),
    costAmount: money("cost_amount").notNull(),
    currency: currency().notNull().default("USD"),
    effectiveDate: date("effective_date").notNull(),
    source: costSource("source").notNull().default("manual"),
    note: text("note"),
    createdBy: uuid("created_by"), // users.id (nullable; e.g. CSV import)
    ...timestamps,
  },
  (t) => [
    // One cost per SKU + origin + effective date; re-importing the same row upserts.
    uniqueIndex("product_costs_sku_origin_date_unique").on(
      t.sku,
      t.origin,
      t.effectiveDate,
    ),
    index("product_costs_sku_idx").on(t.sku),
  ],
);

export type Product = typeof products.$inferSelect;
export type ProductVariant = typeof productVariants.$inferSelect;
export type ProductCost = typeof productCosts.$inferSelect;
export type NewProductCost = typeof productCosts.$inferInsert;

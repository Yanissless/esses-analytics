/**
 * Shopify Orders CSV import (Section 4) — an alternate/supplementary historical
 * load for orders the Admin API can't serve cleanly (archived orders, very large
 * backfills). Feeds the SAME schema as the API path.
 *
 * Dedup: the standard Shopify orders export keys on order Name (e.g. "#1001"),
 * not the numeric API id, so we dedup on `order_number`. Existing orders (from
 * the API) win — a CSV row for a name already present is skipped. Intended for
 * pre-API history where overlap with the API path shouldn't occur.
 *
 * `parseOrdersCsv` is pure (string in, structured out) and unit-tested; the
 * upsert path reuses resolveCustomer + classifyOrder.
 */
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { orderLineItems, orders } from "../../db/schema";
import { resolveCustomer } from "../customers";
import { classifyOrder } from "./revenue-rules";
import { toCents } from "./ingest";

export interface ParsedCsvLine {
  title: string;
  quantity: number;
  priceCents: number;
  sku: string | null;
}

export interface ParsedCsvOrder {
  name: string;
  id: string | null;
  email: string | null;
  currency: string;
  createdAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  discountCents: number;
  refundedCents: number;
  tags: string[];
  paymentMethod: string | null;
  lines: ParsedCsvLine[];
}

type Row = Record<string, string>;

const str = (r: Row, k: string): string | null => {
  const v = r[k];
  return v && v.trim() ? v.trim() : null;
};
const cents = (r: Row, k: string): number => toCents(str(r, k) ?? "0");

export function parseOrdersCsv(content: string): ParsedCsvOrder[] {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true, // tolerate ragged rows in real-world exports
  }) as Row[];

  const byName = new Map<string, ParsedCsvOrder>();
  let lastName: string | null = null;

  for (const row of rows) {
    const name: string | null = str(row, "Name") ?? lastName;
    if (!name) continue;
    lastName = name;

    let order = byName.get(name);
    if (!order) {
      order = {
        name,
        id: str(row, "Id"),
        email: str(row, "Email"),
        currency: str(row, "Currency") ?? "USD",
        createdAt: str(row, "Created at"),
        financialStatus: str(row, "Financial Status"),
        fulfillmentStatus: str(row, "Fulfillment Status"),
        subtotalCents: cents(row, "Subtotal"),
        shippingCents: cents(row, "Shipping"),
        taxCents: cents(row, "Taxes"),
        totalCents: cents(row, "Total"),
        discountCents: cents(row, "Discount Amount"),
        refundedCents: cents(row, "Refunded Amount"),
        tags: (str(row, "Tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
        paymentMethod: str(row, "Payment Method"),
        lines: [],
      };
      byName.set(name, order);
    }

    const lineTitle = str(row, "Lineitem name");
    if (lineTitle) {
      order.lines.push({
        title: lineTitle,
        quantity: Number(str(row, "Lineitem quantity") ?? "1") || 1,
        priceCents: cents(row, "Lineitem price"),
        sku: str(row, "Lineitem sku"),
      });
    }
  }

  return [...byName.values()];
}

export interface CsvImportResult {
  ordersIn: number;
  ordersInserted: number;
  skippedExisting: number;
}

export async function importOrdersCsvContent(content: string): Promise<CsvImportResult> {
  const parsed = parseOrdersCsv(content);
  let inserted = 0;
  let skipped = 0;

  for (const o of parsed) {
    const [existing] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.orderNumber, o.name))
      .limit(1);
    if (existing) {
      skipped++;
      continue;
    }

    const customerId = o.email
      ? await resolveCustomer({ email: o.email })
      : null;

    const classification = classifyOrder({
      tags: o.tags,
      appName: null,
      paymentGatewayNames: o.paymentMethod ? [o.paymentMethod] : [],
      totalCents: o.totalCents,
      // CSV has no "received" figure; assume paid == total unless status says otherwise.
      receivedCents: o.financialStatus === "paid" || !o.financialStatus ? o.totalCents : 0,
      lineItems: o.lines.map((l) => ({ title: l.title, sellingPlanId: null })),
    });

    const [inserted_] = await db
      .insert(orders)
      .values({
        shopifyOrderId: o.id ?? `csv:${o.name}`,
        customerId,
        orderType: classification.orderType,
        countsAsRevenue: classification.countsAsRevenue,
        revenueExternalSource: classification.revenueExternalSource,
        orderNumber: o.name,
        processedAt: o.createdAt ? new Date(o.createdAt) : null,
        shopifyCreatedAt: o.createdAt ? new Date(o.createdAt) : null,
        currency: o.currency,
        subtotalAmount: o.subtotalCents,
        totalDiscountsAmount: o.discountCents,
        shippingAmount: o.shippingCents,
        totalTaxAmount: o.taxCents,
        totalAmount: o.totalCents,
        amountReceivedAmount: classification.countsAsRevenue ? o.totalCents : 0,
        totalRefundedAmount: o.refundedCents,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        sourceName: "csv_import",
      })
      .returning({ id: orders.id });

    for (const line of o.lines) {
      await db.insert(orderLineItems).values({
        orderId: inserted_.id,
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
        currency: o.currency,
        priceAmount: line.priceCents,
      });
    }
    inserted++;
  }

  return { ordersIn: parsed.length, ordersInserted: inserted, skippedExisting: skipped };
}

export async function importOrdersCsvFile(path: string): Promise<CsvImportResult> {
  return importOrdersCsvContent(readFileSync(path, "utf8"));
}

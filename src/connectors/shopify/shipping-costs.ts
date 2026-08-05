/**
 * Automatic shipping-label cost sync via ShopifyQL.
 *
 * Shopify's Admin GraphQL API has no label-price field on `Fulfillment`, BUT the
 * analytics layer does: `shopifyqlQuery` can read the `shipping_labels` dataset,
 * which is the same source behind the "Shipping labels by order" report. Verified
 * live against this shop — rows come back as keyed objects with `order_name`,
 * `shipping_carrier`, `shipping_service`, `destination_country` and
 * `shipping_label_costs`.
 *
 * Requires the **read_reports** scope on the access token (in addition to the
 * order/product scopes). Without it this query fails while the rest of the sync
 * keeps working, so shipping cost simply stays on estimates.
 *
 * Charges attach to orders by order NAME (e.g. "#13818"), so cost is exact rather
 * than allocated. The CSV importer remains available for the same data.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { shippingCharges, shippingInvoices, shippingRateRules } from "../../db/schema";
import { logger } from "../../lib/logger";
import { attachItemisedCharges, type ItemisedLine } from "../../lib/shipping/match";
import { shopifyGraphQL } from "./client";
import { deriveRates, type ShippingReportRow } from "./shipping-report";

const SHOPIFYQL_QUERY = /* GraphQL */ `
  query ShippingLabelCosts($q: String!) {
    shopifyqlQuery(query: $q) {
      parseErrors
      tableData {
        rows
        columns { name dataType }
      }
    }
  }
`;

interface ShopifyqlResult {
  shopifyqlQuery?: {
    parseErrors?: string[] | null;
    tableData?: { rows?: Array<Record<string, unknown>> | null } | null;
  } | null;
}

const toCents = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};

/**
 * Pull label costs for a date window. ShopifyQL caps result size, so the window is
 * walked one month at a time — this store runs ~700 labels/month, comfortably
 * inside the limit, and monthly chunks also make partial failures cheap to retry.
 */
export async function fetchShippingLabelRows(
  since: Date,
  until: Date,
): Promise<ShippingReportRow[]> {
  const out: ShippingReportRow[] = [];
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1));
  const end = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1));

  while (cursor <= end) {
    const monthStart = cursor.toISOString().slice(0, 10);
    const nextMonth = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
    // UNTIL is inclusive in ShopifyQL, so step back a day from the next month.
    const monthEndDate = new Date(nextMonth.getTime() - 24 * 3600 * 1000);
    const monthEnd = monthEndDate.toISOString().slice(0, 10);

    const q =
      `FROM shipping_labels SHOW shipping_label_costs ` +
      `GROUP BY order_name, shipping_carrier, shipping_service, destination_country ` +
      `SINCE ${monthStart} UNTIL ${monthEnd} LIMIT 1000`;

    const data = await shopifyGraphQL<ShopifyqlResult>(SHOPIFYQL_QUERY, { q });
    const errors = data.shopifyqlQuery?.parseErrors ?? [];
    if (errors.length) {
      throw new Error(`ShopifyQL parse error: ${errors.join("; ")}`);
    }

    const rows = data.shopifyqlQuery?.tableData?.rows ?? [];
    for (const r of rows) {
      const orderName = str(r.order_name);
      if (!orderName) continue;
      out.push({
        month: monthStart,
        orderName: orderName.startsWith("#") ? orderName : `#${orderName}`,
        originCountry: str(r.origin_country),
        destinationCountry: str(r.destination_country),
        carrier: str(r.shipping_carrier),
        service: str(r.shipping_service),
        costCents: toCents(r.shipping_label_costs),
      });
    }

    if (rows.length >= 1000) {
      logger.warn(`ShopifyQL hit the 1000-row cap for ${monthStart} — costs may be incomplete`, {
        month: monthStart,
      });
    }

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return out;
}

export interface ShippingCostSyncResult {
  labels: number;
  matched: number;
  unmatched: number;
  attributedCents: number;
  ratesRefreshed: number;
}

/** Refresh rate rules from observed medians so uncovered shipments stay credible. */
async function refreshRateRules(rows: ShippingReportRow[]): Promise<number> {
  const rates = deriveRates(rows);
  let n = 0;
  for (const r of rates) {
    if (r.shipments < 3) continue;
    const values = {
      label: `${r.carrier} ${r.scope} (from report)`,
      carrierPattern: r.carrier,
      servicePattern: null,
      countryCode: r.scope === "domestic" ? "US" : null,
      // deriveRates() calls a label domestic when its destination is the US, so
      // the international bucket means "anywhere but the US" — not "anywhere".
      // Without this exclusion a US shipment on a carrier that has no domestic
      // rule of its own picked up the international rate.
      excludeCountryCode: r.scope === "domestic" ? null : "US",
      zone: null,
      currency: "USD",
      expectedCostAmount: r.medianCents, // median — express labels skew the mean
      priority: r.scope === "domestic" ? 60 : 50,
      effectiveDate: "2025-10-01",
      source: `ShopifyQL shipping_labels (${r.shipments} labels)`,
      note: `median $${(r.medianCents / 100).toFixed(2)}, mean $${(r.avgCents / 100).toFixed(2)}`,
    };
    await db
      .insert(shippingRateRules)
      .values(values)
      .onConflictDoUpdate({
        target: [shippingRateRules.label, shippingRateRules.effectiveDate],
        set: { ...values, updatedAt: new Date() },
      });
    n++;
  }
  return n;
}

/**
 * Sync actual label costs for a window and attach them to orders. Idempotent: the
 * invoice is keyed on (vendor, ref) and its charge rows are replaced each run.
 */
export async function syncShippingLabelCosts(
  since: Date,
  until: Date,
): Promise<ShippingCostSyncResult> {
  const rows = await fetchShippingLabelRows(since, until);
  if (!rows.length) {
    return { labels: 0, matched: 0, unmatched: 0, attributedCents: 0, ratesRefreshed: 0 };
  }

  const ratesRefreshed = await refreshRateRules(rows);
  const totalCents = rows.reduce((s, r) => s + r.costCents, 0);
  const invoiceRef = `shopifyql-${since.toISOString().slice(0, 10)}-${until.toISOString().slice(0, 10)}`;

  const [invoice] = await db
    .insert(shippingInvoices)
    .values({
      vendor: "shopify_shipping",
      invoiceRef,
      invoiceDate: until.toISOString().slice(0, 10),
      periodStart: since.toISOString().slice(0, 10),
      periodEnd: until.toISOString().slice(0, 10),
      totalAmount: totalCents,
      statedShipmentCount: rows.length,
      allocationMethod: "itemised",
      note: "Auto-synced from ShopifyQL shipping_labels dataset.",
    })
    .onConflictDoUpdate({
      target: [shippingInvoices.vendor, shippingInvoices.invoiceRef],
      set: { totalAmount: totalCents, statedShipmentCount: rows.length, updatedAt: new Date() },
    })
    .returning({ id: shippingInvoices.id });

  await db.delete(shippingCharges).where(eq(shippingCharges.invoiceId, invoice.id));

  const lines: ItemisedLine[] = rows.map((r) => ({
    trackingNumber: null,
    orderNumber: r.orderName,
    shippedOn: r.month,
    shipCents: r.costCents,
    dutiesCents: 0,
    surchargeCents: 0,
    note: [r.carrier, r.service].filter(Boolean).join(" · ") || null,
  }));

  const res = await attachItemisedCharges(invoice.id, "shopify_shipping", lines);

  return {
    labels: rows.length,
    matched: res.matched,
    unmatched: res.unmatched,
    attributedCents: res.totalAttributedCents,
    ratesRefreshed,
  };
}

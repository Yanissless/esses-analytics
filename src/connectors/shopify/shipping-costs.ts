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
import { eq, sql } from "drizzle-orm";
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
 * ShopifyQL's hard row cap. There is no cursor or offset on `shopifyqlQuery`, so the only way
 * past it is to ask for a narrower date range.
 */
const ROW_CAP = 1000;

/** Days in a slice below which splitting further cannot help. */
const MIN_SLICE_DAYS = 1;

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

/**
 * Fetch one date range, splitting it in half whenever the response hits the row cap.
 *
 * ## Why splitting rather than warning
 *
 * This used to ask for a whole month with `LIMIT 1000`, log a warning if it got 1,000 rows
 * back, and keep the truncated result. Five months tripped that: November returned 275 labels
 * against 452 in the manual import, March 907 against 1,206, May 1,000 against 1,780. The
 * costs were simply missing, and because shipping is a CM2 component, missing cost means
 * overstated margin — with nothing on screen to say so, only a line in a log nobody reads.
 *
 * Halving is self-correcting: it adapts to whatever volume a period actually has instead of
 * assuming "~700 labels/month, comfortably inside the limit", which was true when written and
 * is no longer true as the store has grown. A cap hit on a single day is the one case it
 * cannot fix, and that is reported as a warning the caller surfaces rather than swallows.
 */
async function fetchRange(
  since: Date,
  until: Date,
  month: string,
  warnings: string[],
): Promise<ShippingReportRow[]> {
  const q =
    `FROM shipping_labels SHOW shipping_label_costs ` +
    `GROUP BY order_name, shipping_carrier, shipping_service, destination_country ` +
    `SINCE ${isoDay(since)} UNTIL ${isoDay(until)} LIMIT ${ROW_CAP}`;

  const data = await shopifyGraphQL<ShopifyqlResult>(SHOPIFYQL_QUERY, { q });
  const errors = data.shopifyqlQuery?.parseErrors ?? [];
  if (errors.length) {
    throw new Error(`ShopifyQL parse error: ${errors.join("; ")}`);
  }

  const rows = data.shopifyqlQuery?.tableData?.rows ?? [];
  const spanDays = Math.round((until.getTime() - since.getTime()) / 86_400_000) + 1;

  if (rows.length >= ROW_CAP && spanDays > MIN_SLICE_DAYS) {
    // Split and recurse. Both halves are inside the same calendar month when the caller walks
    // monthly, so `month` stays correct for invoice grouping.
    const mid = addDays(since, Math.floor(spanDays / 2) - 1);
    const left = await fetchRange(since, mid, month, warnings);
    const right = await fetchRange(addDays(mid, 1), until, month, warnings);
    return [...left, ...right];
  }

  if (rows.length >= ROW_CAP) {
    // A single day at the cap. Nothing left to narrow, so say so loudly instead of returning a
    // truncated figure that looks whole.
    warnings.push(
      `${isoDay(since)} returned the ShopifyQL row cap (${ROW_CAP}) for a single day — label ` +
        `costs for that day are incomplete`,
    );
  }

  const out: ShippingReportRow[] = [];
  for (const r of rows) {
    const orderName = str(r.order_name);
    if (!orderName) continue;
    out.push({
      month,
      orderName: orderName.startsWith("#") ? orderName : `#${orderName}`,
      originCountry: str(r.origin_country),
      destinationCountry: str(r.destination_country),
      carrier: str(r.shipping_carrier),
      service: str(r.shipping_service),
      costCents: toCents(r.shipping_label_costs),
    });
  }
  return out;
}

/**
 * Pull label costs for a date window, walking one calendar month at a time.
 *
 * Monthly chunks make partial failures cheap to retry and give the invoice its natural key.
 * Each month is fetched by `fetchRange`, which narrows further on its own if the month holds
 * more labels than one query can return.
 */
export async function fetchShippingLabelRows(
  since: Date,
  until: Date,
  warnings: string[] = [],
): Promise<ShippingReportRow[]> {
  const out: ShippingReportRow[] = [];
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1));
  const end = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1));

  while (cursor <= end) {
    const monthStart = isoDay(cursor);
    const nextMonth = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
    // UNTIL is inclusive in ShopifyQL, so step back a day from the next month.
    const monthEndDate = addDays(nextMonth, -1);

    out.push(...(await fetchRange(cursor, monthEndDate, monthStart, warnings)));

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
  /**
   * Cap hits that could not be resolved by narrowing the window.
   *
   * Returned rather than only logged, so the caller can put them on the sync run. A cost
   * figure that is quietly incomplete reads as complete, and shipping feeds CM2.
   */
  warnings: string[];
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
 * Sync actual label costs and attach them to orders. One invoice per CALENDAR MONTH.
 *
 * ## Why monthly, and not per sync window
 *
 * The invoice ref used to embed the window: `shopifyql-<since>-<until>`. That is idempotent
 * for a fixed window and quietly catastrophic for a rolling one, which is what the nightly
 * sync passes. Every run produced a NEW ref, so a new invoice, so a fresh copy of charges for
 * labels already recorded by yesterday's run.
 *
 * The live data showed exactly that: five invoices with overlapping windows
 * (2026-07-14→08-14, 07-19→08-19, 07-20→08-20, 07-21→08-21 plus the manual import), and order
 * #13818 carrying the identical $59.46 charge five times. 1,038 orders were affected and
 * roughly $16,975 of shipping cost was double-counted — which pushes CM2 and CM3 DOWN, so it
 * was understating margin rather than flattering it. Growing by one copy per night.
 *
 * A calendar month is the right key because it is the grain the data already has:
 * `fetchShippingLabelRows` walks month by month and stamps every row with its month. Monthly
 * invoices are therefore non-overlapping by construction, idempotent no matter what window
 * the caller asks for, and they preserve history — re-reading August replaces August and
 * leaves July alone.
 *
 * The previous design could not preserve history AND stay single-invoice: one rolling invoice
 * whose charges are replaced each run would delete every label older than the window.
 */
export async function syncShippingLabelCosts(
  since: Date,
  until: Date,
): Promise<ShippingCostSyncResult> {
  const capWarnings: string[] = [];
  const rows = await fetchShippingLabelRows(since, until, capWarnings);
  if (!rows.length) {
    return { labels: 0, matched: 0, unmatched: 0, attributedCents: 0, ratesRefreshed: 0, warnings: capWarnings };
  }

  const ratesRefreshed = await refreshRateRules(rows);

  // Group by the month each row already carries, so the invoice grain matches the data grain.
  //
  // `month` is nullable on ShippingReportRow because the CSV importer accepts a blank Month
  // column. This path always sets it, so a null here means the shape changed — reported rather
  // than coerced into some arbitrary month, which would file real cost against the wrong period.
  const byMonth = new Map<string, typeof rows>();
  let undatedLabels = 0;
  for (const r of rows) {
    if (!r.month) {
      undatedLabels += 1;
      continue;
    }
    const list = byMonth.get(r.month);
    if (list) list.push(r);
    else byMonth.set(r.month, [r]);
  }
  if (undatedLabels > 0) {
    capWarnings.push(
      `${undatedLabels} label(s) arrived with no month and were skipped — they cannot be filed ` +
        `against a period`,
    );
  }

  let matched = 0;
  let unmatched = 0;
  let attributedCents = 0;

  /*
   * Months already owned by a manually imported invoice are left alone.
   *
   * Two sources describing the same month means every order in it carries two charges, and
   * shipping cost doubles. That is not hypothetical — it is what the first version of this
   * monthly rewrite produced: 4,808 orders with two charges each, because a full-history
   * re-sync recreated ten months that a one-off CSV import already covered.
   *
   * The manual import wins for its own period, and on the evidence it should: it holds 1,780
   * labels for May against this sync's 1,165, because ShopifyQL returns at most 1,000 rows for
   * a single day and 30 May exceeded that on its own. No amount of narrowing gets past a
   * one-day cap, so for those months the CSV is simply the better record.
   *
   * Checked per month rather than by comparing period ranges, because a range comparison gets
   * the boundaries wrong the moment an import is off by a day.
   */
  const claimed = new Set(
    [
      ...(await db.execute<{ mo: string }>(sql`
        SELECT DISTINCT to_char(sc.shipped_on, 'YYYY-MM') AS mo
          FROM shipping_charges sc
          JOIN shipping_invoices si ON si.id = sc.invoice_id
         WHERE sc.shipped_on IS NOT NULL
           AND si.invoice_ref NOT LIKE 'shopifyql-%'
      `)),
    ].map((r) => r.mo),
  );

  const skipped: string[] = [];

  for (const [month, monthRows] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    if (claimed.has(month.slice(0, 7))) {
      skipped.push(month.slice(0, 7));
      continue;
    }
    const totalCents = monthRows.reduce((s, r) => s + r.costCents, 0);
    // Stable per month: re-running any window that touches this month hits the same row.
    const invoiceRef = `shopifyql-${month.slice(0, 7)}`;
    const monthEnd = new Date(Date.UTC(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)), // month index + 1 → last day of this month
      0,
    ))
      .toISOString()
      .slice(0, 10);

    const [invoice] = await db
      .insert(shippingInvoices)
      .values({
        vendor: "shopify_shipping",
        invoiceRef,
        invoiceDate: monthEnd,
        periodStart: month,
        periodEnd: monthEnd,
        totalAmount: totalCents,
        statedShipmentCount: monthRows.length,
        allocationMethod: "itemised",
        note: `Auto-synced from ShopifyQL shipping_labels dataset (${month.slice(0, 7)}).`,
      })
      .onConflictDoUpdate({
        target: [shippingInvoices.vendor, shippingInvoices.invoiceRef],
        set: {
          totalAmount: totalCents,
          statedShipmentCount: monthRows.length,
          invoiceDate: monthEnd,
          periodStart: month,
          periodEnd: monthEnd,
          updatedAt: new Date(),
        },
      })
      .returning({ id: shippingInvoices.id });

    // Replace this month's charges only. The delete is what makes a re-read a correction
    // rather than an addition.
    await db.delete(shippingCharges).where(eq(shippingCharges.invoiceId, invoice.id));

    const lines: ItemisedLine[] = monthRows.map((r) => ({
      trackingNumber: null,
      orderNumber: r.orderName,
      shippedOn: r.month,
      shipCents: r.costCents,
      dutiesCents: 0,
      surchargeCents: 0,
      note: [r.carrier, r.service].filter(Boolean).join(" · ") || null,
    }));

    const res = await attachItemisedCharges(invoice.id, "shopify_shipping", lines);
    matched += res.matched;
    unmatched += res.unmatched;
    attributedCents += res.totalAttributedCents;
  }

  if (skipped.length) {
    // A warning, not silence: "shipping cost is complete" and "shipping cost is complete
    // because another import owns these months" are different claims, and only one of them
    // survives someone deleting that import.
    capWarnings.push(
      `${skipped.length} month(s) left to an existing manual import: ${skipped.join(", ")}`,
    );
  }

  logger.info("Shipping label costs synced by month", {
    monthsSeen: byMonth.size,
    monthsWritten: byMonth.size - skipped.length,
    skipped,
    labels: rows.length,
    matched,
    unmatched,
  });

  return {
    labels: rows.length,
    matched,
    unmatched,
    attributedCents,
    ratesRefreshed,
    // Surfaced on the sync run rather than only logged: an incomplete cost figure that looks
    // whole is the failure this whole change is about.
    warnings: capWarnings,
  };
}

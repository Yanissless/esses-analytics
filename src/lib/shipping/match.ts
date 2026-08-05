/**
 * Attach real shipping costs to shipments.
 *
 * Two billing shapes, both supported:
 *
 *  1. ITEMISED (EasyShip, carrier invoices) — one line per shipment with a
 *     tracking number. We match tracking → `fulfillments.tracking_number` and
 *     attribute the exact cost, including prepaid duties (DDP), which is real
 *     cost on subscription/comp orders that collected $0.
 *
 *  2. BATCH (the UK printer park) — a lump sum covering everything it fulfilled
 *     in a period. We find the shipments it plausibly covers (fulfilment location
 *     and/or carrier, within the period) and spread the total across them, either
 *     evenly per shipment or weighted by units. Every allocated charge is marked
 *     `attribution = 'allocated'` so nobody mistakes an estimate for an invoice
 *     line, and the invoice records allocated-vs-total so under/over-allocation is
 *     visible rather than silent.
 *
 * Tracking-number matching is normalised (case/space/punctuation stripped)
 * because carrier portals and spreadsheets rarely agree on formatting.
 */
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { fulfillments, shippingCharges, shippingInvoices } from "../../db/schema";

/** Strip formatting so "1Z K414 4668" matches "1zk4144668". */
export function normalizeTracking(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return t || null;
}

export interface ItemisedLine {
  trackingNumber?: string | null;
  orderNumber?: string | null;
  shippedOn?: string | null;
  shipCents: number;
  dutiesCents?: number;
  surchargeCents?: number;
  note?: string | null;
}

export interface AttachResult {
  matched: number;
  unmatched: number;
  totalAttributedCents: number;
  unmatchedRefs: string[];
}

/** Attach itemised invoice lines to shipments by tracking number, then order number. */
export async function attachItemisedCharges(
  invoiceId: string,
  vendor: string,
  lines: ItemisedLine[],
): Promise<AttachResult> {
  let matched = 0;
  let total = 0;
  const unmatchedRefs: string[] = [];

  for (const line of lines) {
    const norm = normalizeTracking(line.trackingNumber);
    let fulfillmentId: string | null = null;
    let orderId: string | null = null;
    let matchedBy: string | null = null;

    if (norm) {
      const [hit] = (await db.execute(sql`
        SELECT id, order_id FROM fulfillments
         WHERE regexp_replace(lower(coalesce(tracking_number,'')), '[^a-z0-9]', '', 'g') = ${norm}
         LIMIT 1
      `)) as unknown as Array<{ id: string; order_id: string }>;
      if (hit) {
        fulfillmentId = hit.id;
        orderId = hit.order_id;
        matchedBy = "tracking";
      }
    }

    if (!fulfillmentId && line.orderNumber) {
      const key = line.orderNumber.startsWith("#") ? line.orderNumber : `#${line.orderNumber}`;
      const [hit] = (await db.execute(sql`
        SELECT id FROM orders WHERE order_number = ${key} LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      if (hit) {
        orderId = hit.id;
        matchedBy = "order_number";
      }
    }

    const ship = line.shipCents ?? 0;
    const duties = line.dutiesCents ?? 0;
    const surcharge = line.surchargeCents ?? 0;
    const lineTotal = ship + duties + surcharge;

    if (!orderId && !fulfillmentId) {
      unmatchedRefs.push(line.trackingNumber ?? line.orderNumber ?? "(no reference)");
      continue;
    }

    await db.insert(shippingCharges).values({
      invoiceId,
      fulfillmentId,
      orderId,
      vendor,
      trackingNumber: line.trackingNumber ?? null,
      shippedOn: line.shippedOn ?? null,
      shipAmount: ship,
      dutiesAmount: duties,
      surchargeAmount: surcharge,
      totalAmount: lineTotal,
      attribution: "itemised",
      matchedBy,
      note: line.note ?? null,
    });

    matched++;
    total += lineTotal;
  }

  await db
    .update(shippingInvoices)
    .set({ allocatedAmount: total, allocationMethod: "itemised", updatedAt: new Date() })
    .where(eq(shippingInvoices.id, invoiceId));

  return {
    matched,
    unmatched: unmatchedRefs.length,
    totalAttributedCents: total,
    unmatchedRefs,
  };
}

/**
 * Expected label cost for a shipment from `shipping_rate_rules` — highest-priority
 * matching rule effective at the ship date. Returns null when nothing matches.
 */
export async function expectedRateCents(fulfillmentId: string): Promise<number | null> {
  const [r] = (await db.execute(sql`
    SELECT rr.expected_cost_amount AS cents
      FROM fulfillments f
      JOIN orders o ON o.id = f.order_id
      JOIN shipping_rate_rules rr
        ON (rr.carrier_pattern IS NULL
             OR lower(coalesce(f.tracking_company,'')) LIKE '%' || lower(rr.carrier_pattern) || '%')
       AND (rr.service_pattern IS NULL
             OR lower(coalesce(f.service_name,'')) LIKE '%' || lower(rr.service_pattern) || '%')
       AND (rr.country_code IS NULL
             OR rr.country_code = COALESCE(o.shipping_country, o.billing_country))
       AND (rr.exclude_country_code IS NULL
             OR rr.exclude_country_code
                <> COALESCE(o.shipping_country, o.billing_country, ''))
       AND rr.effective_date <= COALESCE(f.shipped_at::date, CURRENT_DATE)
     WHERE f.id = ${fulfillmentId}
     ORDER BY rr.priority DESC, rr.effective_date DESC
     LIMIT 1
  `)) as unknown as Array<{ cents: number }>;
  return r ? Number(r.cents) : null;
}

export interface BatchCriteria {
  /** Fulfilment location name as it appears in Shopify (e.g. the UK park). */
  locationName?: string | null;
  /** Carrier, e.g. "Royal Mail". Matched case-insensitively as a substring. */
  trackingCompany?: string | null;
  /** Restrict to these destination countries (ISO-2). */
  countries?: string[];
  periodStart: string;
  periodEnd: string;
}

export interface BatchAllocationPreview {
  shipmentCount: number;
  unitCount: number;
  perShipmentCents: number;
  fulfillmentIds: string[];
}

/** Find the shipments a batch invoice covers, without writing anything. */
export async function previewBatchShipments(
  criteria: BatchCriteria,
): Promise<BatchAllocationPreview> {
  const rows = (await db.execute(sql`
    SELECT f.id, COALESCE(f.total_quantity, 1) AS units
      FROM fulfillments f
      JOIN orders o ON o.id = f.order_id
     WHERE f.shipped_at::date >= ${criteria.periodStart}
       AND f.shipped_at::date <= ${criteria.periodEnd}
       ${criteria.locationName ? sql`AND f.location_name = ${criteria.locationName}` : sql``}
       ${
         criteria.trackingCompany
           ? sql`AND lower(coalesce(f.tracking_company,'')) LIKE ${"%" + criteria.trackingCompany.toLowerCase() + "%"}`
           : sql``
       }
       ${
         criteria.countries?.length
           ? sql`AND COALESCE(o.shipping_country, o.billing_country) = ANY(${criteria.countries})`
           : sql``
       }
       -- Don't double-charge a shipment that already has an itemised cost.
       AND NOT EXISTS (
         SELECT 1 FROM shipping_charges sc
          WHERE sc.fulfillment_id = f.id AND sc.attribution = 'itemised'
       )
  `)) as unknown as Array<{ id: string; units: number }>;

  const unitCount = rows.reduce((s, r) => s + Number(r.units ?? 1), 0);
  return {
    shipmentCount: rows.length,
    unitCount,
    perShipmentCents: 0,
    fulfillmentIds: rows.map((r) => r.id),
  };
}

/**
 * Spread a batch invoice total across the shipments it covers.
 * `method`: 'even' (per shipment) or 'by_units' (weighted by items shipped).
 * Rounding remainder lands on the last shipment so the allocation reconciles
 * exactly to the invoice total.
 */
export async function allocateBatchInvoice(
  invoiceId: string,
  vendor: string,
  totalCents: number,
  criteria: BatchCriteria,
  method: "even" | "by_units" | "by_rate" = "even",
): Promise<{ shipments: number; allocatedCents: number; rateCoveredShipments?: number }> {
  const rows = (await db.execute(sql`
    SELECT f.id, f.order_id, f.tracking_number, f.shipped_at::date AS shipped_on,
           COALESCE(f.total_quantity, 1) AS units,
           (SELECT rr.expected_cost_amount
              FROM shipping_rate_rules rr
             WHERE (rr.carrier_pattern IS NULL
                     OR lower(coalesce(f.tracking_company,'')) LIKE '%' || lower(rr.carrier_pattern) || '%')
               AND (rr.service_pattern IS NULL
                     OR lower(coalesce(f.service_name,'')) LIKE '%' || lower(rr.service_pattern) || '%')
               AND (rr.country_code IS NULL
                     OR rr.country_code = COALESCE(o.shipping_country, o.billing_country))
               AND (rr.exclude_country_code IS NULL
                     OR rr.exclude_country_code
                        <> COALESCE(o.shipping_country, o.billing_country, ''))
               AND rr.effective_date <= COALESCE(f.shipped_at::date, CURRENT_DATE)
             ORDER BY rr.priority DESC, rr.effective_date DESC
             LIMIT 1) AS expected_rate
      FROM fulfillments f
      JOIN orders o ON o.id = f.order_id
     WHERE f.shipped_at::date >= ${criteria.periodStart}
       AND f.shipped_at::date <= ${criteria.periodEnd}
       ${criteria.locationName ? sql`AND f.location_name = ${criteria.locationName}` : sql``}
       ${
         criteria.trackingCompany
           ? sql`AND lower(coalesce(f.tracking_company,'')) LIKE ${"%" + criteria.trackingCompany.toLowerCase() + "%"}`
           : sql``
       }
       ${
         criteria.countries?.length
           ? sql`AND COALESCE(o.shipping_country, o.billing_country) = ANY(${criteria.countries})`
           : sql``
       }
       AND NOT EXISTS (
         SELECT 1 FROM shipping_charges sc
          WHERE sc.fulfillment_id = f.id AND sc.attribution = 'itemised'
       )
     ORDER BY f.shipped_at
  `)) as unknown as Array<{
    id: string;
    order_id: string;
    tracking_number: string | null;
    shipped_on: string | null;
    units: number;
    expected_rate: number | null;
  }>;

  if (!rows.length) return { shipments: 0, allocatedCents: 0, rateCoveredShipments: 0 };

  // Clear any previous allocation from this invoice so re-running is idempotent.
  await db
    .delete(shippingCharges)
    .where(
      and(eq(shippingCharges.invoiceId, invoiceId), eq(shippingCharges.attribution, "allocated")),
    );

  const totalUnits = rows.reduce((s, r) => s + Number(r.units ?? 1), 0);
  // Rate-weighted allocation: each shipment's share is proportional to its
  // expected label cost (e.g. Media Mail ~$5), then scaled so the whole batch
  // reconciles exactly to the invoice total. Shipments with no matching rate rule
  // fall back to the batch average so they still carry a sensible weight.
  const ratedRows = rows.filter((r) => r.expected_rate != null);
  const avgRate =
    ratedRows.length > 0
      ? ratedRows.reduce((s, r) => s + Number(r.expected_rate), 0) / ratedRows.length
      : 0;
  const weightOf = (r: (typeof rows)[number]): number =>
    Number(r.expected_rate ?? avgRate) || 1;
  const totalWeight = rows.reduce((s, r) => s + weightOf(r), 0);

  let running = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isLast = i === rows.length - 1;
    const share =
      method === "by_rate" && totalWeight > 0
        ? Math.round((totalCents * weightOf(r)) / totalWeight)
        : method === "by_units" && totalUnits > 0
          ? Math.round((totalCents * Number(r.units ?? 1)) / totalUnits)
          : Math.round(totalCents / rows.length);
    // Last shipment absorbs the rounding remainder → allocation == invoice total.
    const amount = isLast ? totalCents - running : share;
    running += amount;

    await db.insert(shippingCharges).values({
      invoiceId,
      fulfillmentId: r.id,
      orderId: r.order_id,
      vendor,
      trackingNumber: r.tracking_number,
      shippedOn: r.shipped_on,
      shipAmount: amount,
      dutiesAmount: 0,
      surchargeAmount: 0,
      totalAmount: amount,
      attribution: "allocated",
      matchedBy: "period",
      note: `Batch allocation (${method}) across ${rows.length} shipments.`,
    });
  }

  await db
    .update(shippingInvoices)
    .set({
      allocatedAmount: running,
      allocationMethod: method,
      updatedAt: new Date(),
    })
    .where(eq(shippingInvoices.id, invoiceId));

  return {
    shipments: rows.length,
    allocatedCents: running,
    rateCoveredShipments: ratedRows.length,
  };
}

/** Coverage stats for the UI: how much shipping cost is actual vs still estimated. */
export async function getShippingCoverage(): Promise<{
  shipmentsTotal: number;
  shipmentsWithActual: number;
  actualCostCents: number;
  dutiesCents: number;
}> {
  const [r] = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM fulfillments)                                  AS shipments_total,
      (SELECT count(DISTINCT fulfillment_id) FROM shipping_charges
        WHERE fulfillment_id IS NOT NULL)                                  AS with_actual,
      (SELECT COALESCE(sum(total_amount),0) FROM shipping_charges)         AS actual_cost,
      (SELECT COALESCE(sum(duties_amount),0) FROM shipping_charges)        AS duties
  `)) as unknown as Array<Record<string, unknown>>;
  return {
    shipmentsTotal: Number(r.shipments_total ?? 0),
    shipmentsWithActual: Number(r.with_actual ?? 0),
    actualCostCents: Number(r.actual_cost ?? 0),
    dutiesCents: Number(r.duties ?? 0),
  };
}

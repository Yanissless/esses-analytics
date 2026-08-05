"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { shippingCharges, shippingInvoices } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import {
  allocateBatchInvoice,
  attachItemisedCharges,
  previewBatchShipments,
  type ItemisedLine,
} from "@/lib/shipping/match";
import { parseEasyshipCsv } from "@/connectors/easyship";

export type ShippingActionState = { error?: string; ok?: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s£€]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function revalidate() {
  revalidatePath("/shipping");
  revalidatePath("/international");
  revalidatePath("/");
}

/**
 * Record a batch bill (UK printer park, or a Shopify shipping-cost report for a
 * period) and spread it across the shipments it covers. `by_rate` weights each
 * shipment by its expected label cost then scales to reconcile exactly to the
 * total — the most accurate option when you only have a period total.
 */
export async function createBatchInvoice(
  _prev: ShippingActionState,
  formData: FormData,
): Promise<ShippingActionState> {
  await requireAdmin();

  const vendor = String(formData.get("vendor") ?? "").trim();
  const invoiceRef = String(formData.get("invoiceRef") ?? "").trim() || null;
  const periodStart = String(formData.get("periodStart") ?? "").trim();
  const periodEnd = String(formData.get("periodEnd") ?? "").trim();
  const total = toCents(String(formData.get("total") ?? ""));
  const method = String(formData.get("method") ?? "by_rate") as "even" | "by_units" | "by_rate";
  const locationName = String(formData.get("locationName") ?? "").trim() || null;
  const trackingCompany = String(formData.get("trackingCompany") ?? "").trim() || null;
  const countriesRaw = String(formData.get("countries") ?? "").trim();
  const countries = countriesRaw
    ? countriesRaw.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)
    : undefined;

  if (!vendor) return { error: "Vendor is required." };
  if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd)) {
    return { error: "Period start and end must be YYYY-MM-DD." };
  }
  if (total == null || total <= 0) return { error: "Invoice total must be a positive amount." };

  const criteria = { locationName, trackingCompany, countries, periodStart, periodEnd };
  const preview = await previewBatchShipments(criteria);
  if (preview.shipmentCount === 0) {
    return {
      error:
        "No shipments matched those filters — check the period, and that fulfilments have synced. Nothing was saved.",
    };
  }

  const [invoice] = await db
    .insert(shippingInvoices)
    .values({
      vendor,
      invoiceRef,
      invoiceDate: periodEnd,
      periodStart,
      periodEnd,
      totalAmount: total,
      allocationMethod: method,
      note: String(formData.get("note") ?? "").trim() || null,
    })
    .onConflictDoUpdate({
      target: [shippingInvoices.vendor, shippingInvoices.invoiceRef],
      set: { totalAmount: total, periodStart, periodEnd, allocationMethod: method, updatedAt: new Date() },
    })
    .returning({ id: shippingInvoices.id });

  const result = await allocateBatchInvoice(invoice.id, vendor, total, criteria, method);
  revalidate();

  const perShipment = result.shipments ? result.allocatedCents / result.shipments : 0;
  return {
    ok:
      `Allocated ${(result.allocatedCents / 100).toFixed(2)} across ${result.shipments} shipment(s) ` +
      `(avg $${(perShipment / 100).toFixed(2)}); ${result.rateCoveredShipments ?? 0} had a matching rate rule.`,
  };
}

/** Import itemised carrier/EasyShip lines and match them to shipments. */
export async function importItemisedCsv(
  _prev: ShippingActionState,
  formData: FormData,
): Promise<ShippingActionState> {
  await requireAdmin();

  const vendor = String(formData.get("vendor") ?? "easyship").trim();
  const invoiceRef = String(formData.get("invoiceRef") ?? "").trim() || null;
  const format = String(formData.get("format") ?? "easyship");
  const csv = String(formData.get("csv") ?? "").trim();
  if (!csv) return { error: "Paste the CSV export first." };

  let lines: ItemisedLine[] = [];

  if (format === "easyship") {
    lines = parseEasyshipCsv(csv);
    if (!lines.length) {
      return {
        error:
          "No rows parsed. EasyShip exports vary by account — the parser looks for a tracking number/order number column plus charge columns. Try the generic format instead.",
      };
    }
  } else {
    // Generic: tracking_number,ship_cost[,duties,surcharge,order_number,shipped_on]
    const rows = csv.split(/\r?\n/).filter((l) => l.trim());
    const header = rows[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = (...names: string[]) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const iTrack = idx("tracking_number", "tracking");
    const iShip = idx("ship_cost", "shipping_cost", "cost");
    const iDuties = idx("duties", "duties_cost", "import_tax");
    const iSur = idx("surcharge", "fees");
    const iOrder = idx("order_number", "order");
    const iDate = idx("shipped_on", "date");
    if (iTrack < 0 && iOrder < 0) {
      return { error: "Header needs tracking_number or order_number, plus ship_cost." };
    }
    if (iShip < 0) return { error: "Header needs a ship_cost column." };

    for (let n = 1; n < rows.length; n++) {
      const c = rows[n].split(",").map((x) => x.trim());
      const ship = toCents(c[iShip] ?? "");
      if (ship == null) continue;
      const d = iDate >= 0 ? c[iDate] : "";
      lines.push({
        trackingNumber: iTrack >= 0 ? c[iTrack] || null : null,
        orderNumber: iOrder >= 0 ? c[iOrder] || null : null,
        shippedOn: ISO_DATE.test(d ?? "") ? d : null,
        shipCents: ship,
        dutiesCents: iDuties >= 0 ? (toCents(c[iDuties] ?? "") ?? 0) : 0,
        surchargeCents: iSur >= 0 ? (toCents(c[iSur] ?? "") ?? 0) : 0,
      });
    }
    if (!lines.length) return { error: "No valid rows found." };
  }

  const stated = lines.reduce(
    (s, l) => s + l.shipCents + (l.dutiesCents ?? 0) + (l.surchargeCents ?? 0),
    0,
  );

  const [invoice] = await db
    .insert(shippingInvoices)
    .values({
      vendor,
      invoiceRef,
      invoiceDate: new Date().toISOString().slice(0, 10),
      totalAmount: stated,
      statedShipmentCount: lines.length,
      allocationMethod: "itemised",
      note: `Imported ${lines.length} itemised line(s) (${format}).`,
    })
    .onConflictDoUpdate({
      target: [shippingInvoices.vendor, shippingInvoices.invoiceRef],
      set: { totalAmount: stated, statedShipmentCount: lines.length, updatedAt: new Date() },
    })
    .returning({ id: shippingInvoices.id });

  // Replace any previous itemised rows for this invoice so re-import is safe.
  await db.delete(shippingCharges).where(eq(shippingCharges.invoiceId, invoice.id));

  const res = await attachItemisedCharges(invoice.id, vendor, lines);
  revalidate();

  const parts = [`Matched ${res.matched} of ${lines.length} line(s), $${(res.totalAttributedCents / 100).toFixed(2)} attributed.`];
  if (res.unmatched > 0) {
    parts.push(
      `${res.unmatched} unmatched (${res.unmatchedRefs.slice(0, 3).join(", ")}${res.unmatchedRefs.length > 3 ? "…" : ""}) — those shipments may not have synced yet.`,
    );
  }
  return res.unmatched > 0 ? { ok: parts[0], error: parts[1] } : { ok: parts[0] };
}

export async function deleteInvoice(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("invoiceId") ?? "");
  if (!id) return;
  await db.delete(shippingInvoices).where(eq(shippingInvoices.id, id));
  revalidate();
}

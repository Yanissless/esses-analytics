"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { costAssumptions, marginSettings, productCosts } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import { BOUNDARY_META, isMarginBoundary } from "@/metrics/margin-boundary";

export type CostActionState = { error?: string; ok?: string };

/**
 * Every page whose numbers depend on cost settings. Kept in one place because a
 * setting that silently fails to refresh a page is worse than no setting — the user
 * changes it, sees the old figure, and concludes the app is broken.
 */
const MARGIN_DEPENDENT_PATHS = ["/costs", "/international", "/profit", "/personas", "/"];

function revalidateMarginPages(): void {
  for (const p of MARGIN_DEPENDENT_PATHS) revalidatePath(p);
}

/**
 * Change which revenue classes bear cost when margin is computed.
 *
 * Safe to change at will: revenue is identical under all three options because comps
 * and prepaid deliveries collect $0, so this only ever re-filters which costs are
 * charged. Nothing is recomputed or rebuilt.
 */
export async function saveMarginBoundary(
  _prev: CostActionState,
  formData: FormData,
): Promise<CostActionState> {
  await requireAdmin();

  const boundary = String(formData.get("marginBoundary") ?? "").trim();
  if (!isMarginBoundary(boundary)) {
    return { error: "Pick one of the three margin boundaries." };
  }

  // Applies to the newest settings row, which is what getMarginBoundary() reads.
  const [current] = await db
    .select({ effectiveDate: marginSettings.effectiveDate })
    .from(marginSettings)
    .orderBy(desc(marginSettings.effectiveDate))
    .limit(1);

  if (!current) {
    await db.insert(marginSettings).values({
      effectiveDate: new Date().toISOString().slice(0, 10),
      marginBoundary: boundary,
      note: "Created when the margin boundary was first set.",
    });
  } else {
    await db
      .update(marginSettings)
      .set({ marginBoundary: boundary, updatedAt: new Date() })
      .where(eq(marginSettings.effectiveDate, current.effectiveDate));
  }

  revalidateMarginPages();
  return { ok: `Margin boundary set to “${BOUNDARY_META[boundary].label}”.` };
}

function parseMoneyToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Add or update one per-unit cost (SKU + origin + effective date). */
export async function saveProductCost(
  _prev: CostActionState,
  formData: FormData,
): Promise<CostActionState> {
  await requireAdmin();

  const sku = String(formData.get("sku") ?? "").trim();
  const origin = String(formData.get("origin") ?? "default").trim();
  const effectiveDate = String(formData.get("effectiveDate") ?? "").trim();
  const cents = parseMoneyToCents(String(formData.get("cost") ?? ""));
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!sku) return { error: "SKU is required." };
  if (!ISO_DATE.test(effectiveDate)) return { error: "Effective date must be YYYY-MM-DD." };
  if (cents == null) return { error: "Cost must be a non-negative number." };
  if (!["US", "UK", "default"].includes(origin)) return { error: "Unknown origin." };

  const values = {
    sku,
    origin,
    effectiveDate,
    costAmount: cents,
    currency: "USD",
    source: "manual" as const,
    note,
  };

  await db
    .insert(productCosts)
    .values(values)
    .onConflictDoUpdate({
      target: [productCosts.sku, productCosts.origin, productCosts.effectiveDate],
      set: { costAmount: cents, note, updatedAt: new Date() },
    });

  revalidatePath("/costs");
  revalidatePath("/international");
  revalidatePath("/");
  return { ok: `Saved ${sku} (${origin}) at $${(cents / 100).toFixed(2)}.` };
}

/**
 * Same as `saveProductCost`, but void-returning so it can be bound straight onto
 * a `<form action>` (a per-row inline table cell isn't wired to a useActionState
 * hook, so it has nowhere to put `{error, ok}`). Errors are swallowed here on
 * purpose — the manual entry form below is the one place that surfaces them.
 */
export async function saveProductCostInline(formData: FormData): Promise<void> {
  await saveProductCost({}, formData);
}

export async function deleteProductCost(formData: FormData): Promise<void> {
  await requireAdmin();
  const sku = String(formData.get("sku") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const effectiveDate = String(formData.get("effectiveDate") ?? "");
  if (!sku || !origin || !effectiveDate) return;
  await db
    .delete(productCosts)
    .where(
      and(
        eq(productCosts.sku, sku),
        eq(productCosts.origin, origin),
        eq(productCosts.effectiveDate, effectiveDate),
      ),
    );
  revalidatePath("/costs");
  revalidatePath("/international");
}

/**
 * Bulk CSV import. Expected header (case-insensitive, order-independent):
 *   sku, cost, effective_date[, origin, note]
 * Origin defaults to 'default'. Rows that fail validation are reported rather
 * than silently skipped.
 */
export async function importCostsCsv(
  _prev: CostActionState,
  formData: FormData,
): Promise<CostActionState> {
  await requireAdmin();
  const text = String(formData.get("csv") ?? "").trim();
  if (!text) return { error: "Paste some CSV first." };

  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { error: "Need a header row plus at least one data row." };

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iSku = idx("sku");
  const iCost = idx("cost");
  const iDate = header.includes("effective_date") ? idx("effective_date") : idx("effectivedate");
  const iOrigin = idx("origin");
  const iNote = idx("note");

  if (iSku < 0 || iCost < 0 || iDate < 0) {
    return { error: "Header must include: sku, cost, effective_date (origin, note optional)." };
  }

  let saved = 0;
  const problems: string[] = [];

  for (let n = 1; n < lines.length; n++) {
    const cells = lines[n].split(",").map((c) => c.trim());
    const sku = cells[iSku];
    const cents = parseMoneyToCents(cells[iCost] ?? "");
    const effectiveDate = cells[iDate];
    const origin = (iOrigin >= 0 ? cells[iOrigin] : "") || "default";
    const note = iNote >= 0 ? cells[iNote] || null : null;

    if (!sku) { problems.push(`row ${n + 1}: missing SKU`); continue; }
    if (cents == null) { problems.push(`row ${n + 1}: bad cost "${cells[iCost]}"`); continue; }
    if (!ISO_DATE.test(effectiveDate ?? "")) { problems.push(`row ${n + 1}: bad date "${effectiveDate}"`); continue; }
    if (!["US", "UK", "default"].includes(origin)) { problems.push(`row ${n + 1}: bad origin "${origin}"`); continue; }

    const values = {
      sku, origin, effectiveDate, costAmount: cents,
      currency: "USD", source: "csv_import" as const, note,
    };
    await db
      .insert(productCosts)
      .values(values)
      .onConflictDoUpdate({
        target: [productCosts.sku, productCosts.origin, productCosts.effectiveDate],
        set: { costAmount: cents, note, source: "csv_import", updatedAt: new Date() },
      });
    saved++;
  }

  revalidatePath("/costs");
  revalidatePath("/international");
  revalidatePath("/");

  if (problems.length) {
    return {
      ok: saved ? `Imported ${saved} row(s).` : undefined,
      error: `${problems.length} row(s) skipped — ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "…" : ""}`,
    };
  }
  return { ok: `Imported ${saved} row(s).` };
}

/** Update a zone's variable-cost assumptions (shipping, packaging, processing…). */
export async function saveZoneAssumptions(
  _prev: CostActionState,
  formData: FormData,
): Promise<CostActionState> {
  await requireAdmin();

  const zone = String(formData.get("zone") ?? "").trim();
  const effectiveDate = String(formData.get("effectiveDate") ?? "").trim();
  if (!zone) return { error: "Zone is required." };
  if (!ISO_DATE.test(effectiveDate)) return { error: "Effective date must be YYYY-MM-DD." };

  const money = (k: string) => parseMoneyToCents(String(formData.get(k) ?? "0")) ?? 0;
  const pct = (k: string) => {
    const n = Number(String(formData.get(k) ?? "0").replace(/[%\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return 0;
    // Accept either 2.9 (percent) or 0.029 (fraction).
    return n > 1 ? n / 100 : n;
  };

  const values = {
    zone,
    effectiveDate,
    currency: "USD",
    shipCostAmount: money("shipCost"),
    freightPerUnitAmount: money("freightPerUnit"),
    packagingAmount: money("packaging"),
    pickPackAmount: money("pickPack"),
    processingPct: pct("processingPct"),
    returnRatePct: pct("returnRatePct"),
    returnCostAmount: money("returnCost"),
    source: "manual entry",
    note: String(formData.get("note") ?? "").trim() || null,
  };

  await db
    .insert(costAssumptions)
    .values(values)
    .onConflictDoUpdate({
      target: [costAssumptions.zone, costAssumptions.effectiveDate],
      set: { ...values, updatedAt: new Date() },
    });

  revalidatePath("/costs");
  revalidatePath("/international");
  revalidatePath("/");
  return { ok: `Saved ${zone} assumptions effective ${effectiveDate}.` };
}

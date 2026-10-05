"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { ltvCacAssumptions } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";

export type LtvCacActionState = { error?: string; ok?: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROUTES = ["bought", "upgraded"] as const;

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Accepts either 67 (percent) or 0.67 (fraction) — same convention as the
 *  /costs zone-assumptions form, so a team member typing "67" gets 0.67. */
function parsePct(raw: string): number | null {
  const cleaned = raw.replace(/[%\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * Add or update one tier/route's LTV:CAC assumptions, effective-dated exactly
 * like `product_costs` — an edit writes a new row rather than rewriting
 * history, so LTV computed for a past date keeps whatever inputs were true then.
 */
export async function saveLtvCacAssumption(
  _prev: LtvCacActionState,
  formData: FormData,
): Promise<LtvCacActionState> {
  await requireAdmin();

  const tier = String(formData.get("tier") ?? "").trim();
  const tierLabel = String(formData.get("tierLabel") ?? "").trim();
  const route = String(formData.get("route") ?? "").trim();
  const effectiveDate = String(formData.get("effectiveDate") ?? "").trim();

  if (!tier) return { error: "Tier key is required." };
  if (!tierLabel) return { error: "Tier label is required." };
  if (!ROUTES.includes(route as (typeof ROUTES)[number])) {
    return { error: "Route must be 'bought' or 'upgraded'." };
  }
  if (!ISO_DATE.test(effectiveDate)) return { error: "Effective date must be YYYY-MM-DD." };

  const listPriceCents = parseMoney(String(formData.get("listPrice") ?? ""));
  const annualCogsCents = parseMoney(String(formData.get("annualCogs") ?? "0"));
  const cacCents = parseMoney(String(formData.get("cac") ?? ""));
  const introDiscountPct = parsePct(String(formData.get("introDiscountPct") ?? "0"));
  const processingPct = parsePct(String(formData.get("processingPct") ?? "0"));
  const r1 = parsePct(String(formData.get("r1") ?? ""));
  const r2 = parsePct(String(formData.get("r2") ?? ""));
  const discountRatePct = parsePct(String(formData.get("discountRatePct") ?? "15"));
  const horizonYears = Number(formData.get("horizonYears") ?? 3);
  const cycleMonths = Number(formData.get("cycleMonths") ?? 12);
  const targetRatio = Number(formData.get("targetRatio") ?? 3);
  const baseShareRaw = String(formData.get("baseSharePct") ?? "").trim();
  const baseSharePct = baseShareRaw ? parsePct(baseShareRaw) : null;

  if (listPriceCents == null) return { error: "List price must be a non-negative number." };
  if (annualCogsCents == null) {
    return { error: "COGS per billing cycle must be a non-negative number." };
  }
  if (cacCents == null) return { error: "CAC must be a non-negative number." };
  if (introDiscountPct == null) return { error: "Intro discount must be a percentage." };
  if (processingPct == null) return { error: "Processing must be a percentage." };
  if (r1 == null) return { error: "r1 (first-renewal survival rate) is required." };
  if (r2 == null) return { error: "r2 (steady-state retention) is required." };
  if (discountRatePct == null) return { error: "Discount rate must be a percentage." };
  if (!Number.isFinite(horizonYears) || horizonYears < 1) {
    return { error: "Horizon must be at least 1 year." };
  }
  if (!Number.isFinite(cycleMonths) || cycleMonths < 1) {
    return { error: "Billing cycle must be at least 1 month." };
  }
  if (!Number.isFinite(targetRatio) || targetRatio <= 0) {
    return { error: "Target ratio must be positive." };
  }

  const note = String(formData.get("note") ?? "").trim() || null;
  const source = String(formData.get("source") ?? "").trim() || "manual entry";

  const values = {
    tier,
    tierLabel,
    route,
    effectiveDate,
    currency: "USD",
    listPriceCents,
    introDiscountPct,
    processingPct,
    annualCogsCents,
    cycleMonths: Math.round(cycleMonths),
    r1,
    r2,
    discountRatePct,
    horizonYears: Math.round(horizonYears),
    cacCents,
    baseSharePct,
    targetRatio,
    source,
    note,
  };

  await db
    .insert(ltvCacAssumptions)
    .values(values)
    .onConflictDoUpdate({
      target: [ltvCacAssumptions.tier, ltvCacAssumptions.route, ltvCacAssumptions.effectiveDate],
      set: { ...values, updatedAt: new Date() },
    });

  revalidatePath("/ltv-cac");
  revalidatePath("/personas");
  revalidatePath("/churn");
  return { ok: `Saved ${tierLabel} (${route}) effective ${effectiveDate}.` };
}

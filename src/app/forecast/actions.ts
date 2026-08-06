"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { goals } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import { GOAL_METRICS, isGoalMetric } from "@/metrics/forecast";

export type GoalActionState = { error?: string; ok?: string };

const ISO_MONTH_START = /^\d{4}-\d{2}-01$/;

/**
 * Set or clear one monthly target.
 *
 * The unit depends on the metric — cents for money, a whole count otherwise — so the
 * conversion happens here, once, driven by `GOAL_METRICS`. An empty value deletes the
 * goal rather than storing 0, because a 0 target would render as "0% attained" forever
 * instead of "no target set".
 */
export async function saveGoal(
  _prev: GoalActionState,
  formData: FormData,
): Promise<GoalActionState> {
  await requireAdmin();

  const metric = String(formData.get("metric") ?? "").trim();
  const periodStart = String(formData.get("periodStart") ?? "").trim();
  const raw = String(formData.get("target") ?? "").trim();

  if (!isGoalMetric(metric)) return { error: "Unknown metric." };
  if (!ISO_MONTH_START.test(periodStart)) {
    return { error: "Period must be the first day of a month, e.g. 2026-09-01." };
  }

  const meta = GOAL_METRICS[metric];

  if (!raw) {
    await db
      .delete(goals)
      .where(and(eq(goals.periodStart, periodStart), eq(goals.metric, metric)));
    revalidatePath("/forecast");
    return { ok: `Cleared the ${meta.label.toLowerCase()} target for ${periodStart}.` };
  }

  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return { error: "Target must be a positive number." };

  // Money targets are entered in dollars and stored in cents; counts are stored as-is.
  const stored = meta.unit === "money" ? Math.round(n * 100) : Math.round(n);
  if (stored > 2_147_483_647) return { error: "That target is implausibly large." };

  const values = { periodStart, metric, targetAmount: stored };
  await db
    .insert(goals)
    .values(values)
    .onConflictDoUpdate({ target: [goals.periodStart, goals.metric], set: values });

  revalidatePath("/forecast");
  const shown = meta.unit === "money" ? `$${n.toLocaleString()}` : n.toLocaleString();
  return { ok: `${meta.label} target for ${periodStart} set to ${shown}.` };
}

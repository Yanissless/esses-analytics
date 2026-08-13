"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { requireCapability } from "@/lib/auth/current-user";
import {
  MONEY_METRICS,
  parseGoalPlan,
  planMonths,
} from "@/metrics/goal-plan-input";

/**
 * Writes a year of monthly targets.
 *
 * Gated on `settings` rather than `revenue`: anyone who can read the dashboard may model a
 * plan — that is the point of the page — but changing the numbers every badge in the app is
 * measured against is a configuration change. Viewing and saving are deliberately different
 * permissions.
 *
 * The plan is recomputed here from the submitted inputs rather than trusting a hidden field
 * of pre-computed months. A form that posts twelve amounts can be edited to post thirteen, or
 * amounts that don't sum to the annual figure; recomputing means the only thing the client
 * controls is the inputs, and the invariant that the months sum to the year is enforced by
 * the same code that renders the preview.
 */
export async function saveGoals(formData: FormData) {
  await requireCapability("settings");

  const parsed = parseGoalPlan({
    metric: String(formData.get("metric") ?? ""),
    annual: String(formData.get("annual") ?? ""),
    year: String(formData.get("year") ?? ""),
    shape: String(formData.get("shape") ?? ""),
    releases: String(formData.get("releases") ?? ""),
    releaseDay: String(formData.get("releaseDay") ?? ""),
    baseline: String(formData.get("baseline") ?? ""),
  });

  if (!parsed.ok) {
    // The form validates the same way on render, so reaching here means a hand-crafted post.
    throw new Error(parsed.error);
  }

  const { months, metric } = planMonths(parsed.plan);

  for (const m of months) {
    await db.execute(sql`
      INSERT INTO goals (period_start, metric, target_amount, currency)
      VALUES (${m.periodStart}, ${metric}, ${m.target}, 'USD')
      ON CONFLICT (period_start, metric) DO UPDATE SET target_amount = EXCLUDED.target_amount
    `);
  }

  // Both pages read goals: the planner shows what is saved, /forecast shows attainment.
  revalidatePath("/goals");
  revalidatePath("/forecast");
}

/** Removes a metric's targets for a year, so a plan can be un-set rather than only overwritten. */
export async function clearGoals(formData: FormData) {
  await requireCapability("settings");

  const metric = String(formData.get("metric") ?? "");
  const year = Number(formData.get("year") ?? 0);
  if (!MONEY_METRICS.has(metric) && !["orders", "new_customers"].includes(metric)) {
    throw new Error(`Unknown metric: ${metric}`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Unreasonable year: ${year}`);
  }

  await db.execute(sql`
    DELETE FROM goals
     WHERE metric = ${metric}
       AND period_start >= ${`${year}-01-01`}
       AND period_start <= ${`${year}-12-01`}
  `);

  revalidatePath("/goals");
  revalidatePath("/forecast");
}

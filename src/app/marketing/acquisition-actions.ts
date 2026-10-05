"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { acquisitionCampaigns } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import { eq } from "drizzle-orm";

export type AcquisitionActionState = { error?: string; ok?: string };

/**
 * Tag a campaign as (part of) the current acquisition funnel — the flagship
 * CAC card on /marketing sums spend and results across every tagged campaign.
 */
export async function tagAcquisitionCampaign(
  _prev: AcquisitionActionState,
  formData: FormData,
): Promise<AcquisitionActionState> {
  const user = await requireAdmin();

  const campaignId = String(formData.get("campaignId") ?? "").trim();
  const campaignName = String(formData.get("campaignName") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!campaignId) return { error: "Missing campaign id." };
  if (!campaignName) return { error: "Missing campaign name." };

  await db
    .insert(acquisitionCampaigns)
    .values({ campaignId, campaignName, note, taggedBy: user.email })
    .onConflictDoUpdate({
      target: acquisitionCampaigns.campaignId,
      set: { campaignName, note, taggedBy: user.email, updatedAt: new Date() },
    });

  revalidatePath("/marketing");
  return { ok: `Tagged "${campaignName}" as an acquisition campaign.` };
}

/**
 * Untag a campaign. This only removes it from the flagship-CAC calculation —
 * its rows in `ad_spend` are untouched, so it stays searchable for reference
 * against past weeks (see `searchCampaigns`), it just stops counting toward
 * the live number.
 */
export async function untagAcquisitionCampaign(
  _prev: AcquisitionActionState,
  formData: FormData,
): Promise<AcquisitionActionState> {
  await requireAdmin();

  const campaignId = String(formData.get("campaignId") ?? "").trim();
  const campaignName = String(formData.get("campaignName") ?? "").trim();
  if (!campaignId) return { error: "Missing campaign id." };

  await db.delete(acquisitionCampaigns).where(eq(acquisitionCampaigns.campaignId, campaignId));

  revalidatePath("/marketing");
  return { ok: `Untagged "${campaignName || campaignId}" — still searchable below for reference.` };
}

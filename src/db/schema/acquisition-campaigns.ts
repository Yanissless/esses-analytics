import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";

/**
 * Which live Meta campaigns count as "the" acquisition funnel for CAC purposes.
 *
 * ## Why this exists
 *
 * Hugh's weekly CAC tracker (the marketing report) and the app's blended CAC
 * (`/marketing`, `/ltv-cac`) measure different things, and until 15 Sep 2026
 * nothing in the app said so. Hugh's "Actual spend" tracks ONE flagship
 * acquisition campaign at a time — reconciled against `ad_spend` to the penny
 * for "Free Quarterly Campaign - 7/19" ($2,002.48 vs his $2,002.47, week of
 * 3 Aug). The app's blended CAC sums every campaign, including pure-awareness
 * ones ("Editorial Ads Campaign", "Madring Dark Social") that were never
 * meant to be judged on cost-per-signup — which is why blended CAC ran 10-65%
 * higher than Hugh's tracked figure every week without either number being
 * wrong.
 *
 * ## Why a tag table, not a hardcoded list
 *
 * The flagship campaign is not stable — it rotated from "Free Quarterly
 * Campaign - 7/19" to "Sales - $1 Issue" / "Sales - $20 Annual Discount"
 * within the six weeks this was reconciled against, per Hugh's own report
 * ("the free quarterly replaced by the $1 Quarterly and $20 Annual"). A
 * constant in code would need a deploy every time the offer changes; a table
 * lets whoever runs the campaign flip the tag the same week it happens.
 *
 * Untagged, on purpose, is a valid state: `getFlagshipCac` returns null
 * (unmeasurable) rather than 0 when nothing is tagged, so an empty tag table
 * never reads as "acquisition cost is free".
 *
 * Keyed by `campaignId` (Meta's stable identifier) rather than by name —
 * campaign names get "- Copy" appended when duplicated for testing, which
 * would silently untag a campaign's variant.
 */
export const acquisitionCampaigns = pgTable(
  "acquisition_campaigns",
  {
    id: pk(),
    /** Meta's campaign_id, matching ad_spend.campaign_id. */
    campaignId: text("campaign_id").notNull(),
    /** Display name at the time it was tagged, for the audit trail — the
     *  live name in ad_spend is still the source of truth for display. */
    campaignName: text("campaign_name").notNull(),
    /** Who tagged it and why, e.g. "the current flagship offer, replacing
     *  Free Quarterly on 9/1". Free text, shown on the settings row. */
    note: text("note"),
    taggedBy: text("tagged_by"),
    ...timestamps,
  },
  (t) => [uniqueIndex("acquisition_campaigns_campaign_id_unique").on(t.campaignId)],
);

export type AcquisitionCampaign = typeof acquisitionCampaigns.$inferSelect;
export type NewAcquisitionCampaign = typeof acquisitionCampaigns.$inferInsert;

/**
 * Flagship-campaign CAC — the same number Hugh's weekly marketing report
 * tracks by hand, computed live from whichever campaigns are tagged as "the"
 * acquisition funnel.
 *
 * ## Why this is a separate metric from the app's blended CAC
 *
 * Reconciling Hugh's report (15 Sep 2026) against `ad_spend` found his
 * "Actual spend" matches ONE campaign's spend exactly — "Free Quarterly
 * Campaign - 7/19" was $2,002.48 for the week of 3 Aug against his tracked
 * $2,002.47 — while the app's blended CAC (`cac-basis.ts`, used on
 * `/marketing` and `/ltv-cac`) sums every campaign including pure-awareness
 * ones that were never meant to be judged on cost-per-signup. Both numbers
 * are correct; they answer different questions, and averaging them together
 * would hide the one this metric exists to isolate — the true walk-in-the-
 * door cost of whatever offer is currently running.
 *
 * ## Where "gross adds" comes from
 *
 * Hugh's tracker defines gross adds as Meta's own reported results, not a
 * Shopify-derived new-customer count — his Week 1 gross adds of 238 matches
 * `ad_spend.platform_conversions` for the tagged campaign exactly. Using the
 * same field here means this metric reproduces his tracker without needing
 * to cross-reference Shopify at all, and stays honest about being Meta's own
 * attribution rather than ours.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { acquisitionCampaigns } from "../db/schema";
import { ratio } from "./formulas";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
const num = (v: unknown): number => Number(v ?? 0);

export interface FlagshipCacResult {
  spendCents: number;
  results: number;
  cac: number | null;
  /** Campaigns actually tagged and carrying spend in this window — the
   *  audit trail so a caller can show what the number is built from. */
  campaigns: Array<{ campaignId: string; campaignName: string; spendCents: number; results: number }>;
  /** True when nothing is tagged at all — distinct from "tagged, but no
   *  spend fell in this window", which is a normal empty week. */
  noneTagged: boolean;
}

/**
 * CAC for whatever's currently tagged as the acquisition funnel, over a date
 * range. Null CAC (not 0) when there's no tagged spend in the window — an
 * untagged or paused funnel is unmeasurable, not free.
 */
export async function getFlagshipCac(since: string, until: string): Promise<FlagshipCacResult> {
  const [{ n: tagCount }] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM acquisition_campaigns`,
  );
  if (tagCount === 0) {
    return { spendCents: 0, results: 0, cac: null, campaigns: [], noneTagged: true };
  }

  const data = await rows<Record<string, unknown>>(sql`
    SELECT a.campaign_id, a.campaign_name,
           COALESCE(sum(s.spend_amount), 0)::bigint AS spend,
           COALESCE(sum(s.platform_conversions), 0)::int AS results
      FROM acquisition_campaigns a
      LEFT JOIN ad_spend s
        ON s.campaign_id = a.campaign_id
       AND s.date BETWEEN ${since} AND ${until}
     GROUP BY a.campaign_id, a.campaign_name
     ORDER BY spend DESC
  `);

  const campaigns = data.map((r) => ({
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name),
    spendCents: num(r.spend),
    results: num(r.results),
  }));
  const spendCents = campaigns.reduce((s, c) => s + c.spendCents, 0);
  const results = campaigns.reduce((s, c) => s + c.results, 0);

  return {
    spendCents,
    results,
    cac: ratio(spendCents, results),
    campaigns,
    noneTagged: false,
  };
}

export interface AcquisitionTagRow {
  campaignId: string;
  campaignName: string;
  taggedAt: string;
  note: string | null;
}

/** Every currently-tagged campaign, for the settings UI. */
export async function getAcquisitionTags(): Promise<AcquisitionTagRow[]> {
  const rows = await db
    .select({
      campaignId: acquisitionCampaigns.campaignId,
      campaignName: acquisitionCampaigns.campaignName,
      taggedAt: acquisitionCampaigns.createdAt,
      note: acquisitionCampaigns.note,
    })
    .from(acquisitionCampaigns)
    .orderBy(acquisitionCampaigns.createdAt);
  return rows.map((r) => ({
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    taggedAt: r.taggedAt.toISOString(),
    note: r.note,
  }));
}

export interface CampaignCandidateRow {
  campaignId: string;
  campaignName: string;
  /** Spend in the last 30 days with data — recency, so the list leads with
   *  campaigns actually worth tagging rather than every campaign ever run. */
  recentSpendCents: number;
  lastActiveDate: string;
  tagged: boolean;
}

/**
 * Campaigns with spend in roughly the last 30 days, for the "which campaigns
 * are the funnel right now" picker — tagged ones included regardless, so an
 * old flagship someone forgot to untag still shows up to be turned off.
 */
export async function getCampaignCandidates(): Promise<CampaignCandidateRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH bounds AS (SELECT max(date) AS anchor FROM ad_spend),
    recent AS (
      SELECT s.campaign_id, max(s.campaign_name) AS campaign_name,
             sum(s.spend_amount)::bigint AS spend, max(s.date)::text AS last_date
        FROM ad_spend s, bounds
       WHERE s.campaign_id IS NOT NULL AND s.date >= bounds.anchor - interval '30 days'
       GROUP BY s.campaign_id
    )
    SELECT COALESCE(r.campaign_id, a.campaign_id) AS campaign_id,
           COALESCE(r.campaign_name, a.campaign_name) AS campaign_name,
           COALESCE(r.spend, 0)::bigint AS spend,
           COALESCE(r.last_date, '—') AS last_date,
           (a.campaign_id IS NOT NULL) AS tagged
      FROM recent r
      FULL OUTER JOIN acquisition_campaigns a ON a.campaign_id = r.campaign_id
     ORDER BY tagged DESC, spend DESC
  `);
  return data.map((r) => ({
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name),
    recentSpendCents: num(r.spend),
    lastActiveDate: String(r.last_date),
    tagged: Boolean(r.tagged),
  }));
}

/**
 * Search EVERY campaign ever run, not just the last 30 days — the point of
 * this one. A campaign untagged because it's retired (Free Quarterly, once
 * the $1/$20 offers replaced it) drops out of `getCampaignCandidates`'
 * 30-day window within a month; this is how it stays findable for reference
 * against past weeks without cluttering the default picker with everything
 * that's ever run.
 */
export async function searchCampaigns(query: string): Promise<CampaignCandidateRow[]> {
  const q = query.trim();
  if (!q) return [];
  const data = await rows<Record<string, unknown>>(sql`
    WITH matched AS (
      SELECT s.campaign_id, max(s.campaign_name) AS campaign_name,
             sum(s.spend_amount)::bigint AS spend, max(s.date)::text AS last_date
        FROM ad_spend s
       WHERE s.campaign_id IS NOT NULL AND s.campaign_name ILIKE ${"%" + q + "%"}
       GROUP BY s.campaign_id
    )
    SELECT m.campaign_id, m.campaign_name, m.spend, m.last_date,
           (a.campaign_id IS NOT NULL) AS tagged
      FROM matched m
      LEFT JOIN acquisition_campaigns a ON a.campaign_id = m.campaign_id
     ORDER BY m.last_date DESC
     LIMIT 25
  `);
  return data.map((r) => ({
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name),
    recentSpendCents: num(r.spend),
    lastActiveDate: String(r.last_date),
    tagged: Boolean(r.tagged),
  }));
}

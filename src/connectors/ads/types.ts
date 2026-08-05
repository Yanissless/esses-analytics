/**
 * Generic ad-platform contract (Section 3: "adding a new ad platform should be a
 * config/credentials addition, not a rewrite").
 *
 * Every platform normalises its own reporting into `AdSpendRow`, which maps 1:1
 * onto the `ad_spend` table. The shared `ingestAdSpendRows` helper does the
 * upsert, so a new platform only has to fetch and translate — never touch SQL,
 * dedup, or the sync plumbing.
 */
import type { SyncWindow } from "../types";

export type AdPlatformId = "meta" | "google_ads" | "tiktok" | "other";

/** One platform's reporting for one ad on one day, in normalised form. */
export interface AdSpendRow {
  platform: AdPlatformId;
  /** Reporting date (YYYY-MM-DD) in the ad account's timezone. */
  date: string;
  accountId: string;

  campaignId?: string | null;
  campaignName?: string | null;
  adsetId?: string | null;
  adsetName?: string | null;
  adId?: string | null;
  adName?: string | null;

  /** ISO-4217, from the ad account — never assumed to be USD. */
  currency: string;
  /** Spend in minor units (cents). */
  spendAmount: number;
  impressions: number;
  clicks: number;
  /** Platform's own attribution — kept to reconcile against ours (Section 8.4). */
  platformConversions: number;
  platformConversionValueAmount: number;
}

export interface AdPlatformConnector {
  readonly platform: AdPlatformId;
  /** Human label for logs and the connector-settings UI. */
  readonly label: string;

  isConfigured(): boolean;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;

  /**
   * Fetch normalised daily rows for a window. Implementations must page through
   * the platform's API and convert money to minor units.
   */
  fetchSpend(window: SyncWindow): Promise<AdSpendRow[]>;
}

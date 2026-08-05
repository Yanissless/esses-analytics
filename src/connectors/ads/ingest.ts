/**
 * Shared ad-spend upsert. Every platform funnels through here so dedup and
 * idempotency behave identically no matter the source.
 *
 * The natural key is (platform, account, date, ad) — matching the unique index on
 * `ad_spend` — so re-syncing a day overwrites rather than duplicating. That
 * matters because ad platforms restate recent days as conversions land late.
 */
import { db } from "../../db/client";
import { adSpend } from "../../db/schema";
import { logger } from "../../lib/logger";
import type { AdSpendRow } from "./types";

export interface AdIngestResult {
  rowsIn: number;
  rowsUpserted: number;
  warnings: string[];
}

export async function ingestAdSpendRows(rows: AdSpendRow[]): Promise<AdIngestResult> {
  const warnings: string[] = [];
  let upserted = 0;

  // Platforms sometimes return an ad-level row with no ad id (e.g. account-level
  // rollups). Those can't satisfy the natural key, so they'd silently collide;
  // flag rather than write them.
  const usable = rows.filter((r) => {
    if (!r.adId) {
      warnings.push(
        `${r.platform} ${r.date}: row with no ad id skipped (campaign ${r.campaignId ?? "?"})`,
      );
      return false;
    }
    return true;
  });

  for (const r of usable) {
    const values = {
      platform: r.platform,
      date: r.date,
      accountId: r.accountId,
      campaignId: r.campaignId ?? null,
      campaignName: r.campaignName ?? null,
      adsetId: r.adsetId ?? null,
      adsetName: r.adsetName ?? null,
      adId: r.adId ?? null,
      adName: r.adName ?? null,
      currency: r.currency.toUpperCase(),
      spendAmount: r.spendAmount,
      impressions: r.impressions,
      clicks: r.clicks,
      platformConversions: r.platformConversions,
      platformConversionValueAmount: r.platformConversionValueAmount,
    };

    await db
      .insert(adSpend)
      .values(values)
      .onConflictDoUpdate({
        target: [adSpend.platform, adSpend.accountId, adSpend.date, adSpend.adId],
        set: { ...values, updatedAt: new Date() },
      });
    upserted++;
  }

  if (warnings.length) {
    logger.warn(`Ad spend ingest skipped ${warnings.length} row(s) without an ad id`);
  }

  return { rowsIn: rows.length, rowsUpserted: upserted, warnings: warnings.slice(0, 20) };
}

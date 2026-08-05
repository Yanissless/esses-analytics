/**
 * Ad-platform registry.
 *
 * Adding a platform = write one module satisfying `AdPlatformConnector`, add its
 * credentials to env, and append it here. Nothing else in the app changes: the
 * sync scripts, ad_spend upsert, and metrics all work off the registry.
 *
 * Google Ads and TikTok are deliberately absent rather than stubbed — an
 * unimplemented entry that silently returns zero rows would look like "no spend"
 * instead of "not connected", which is exactly the kind of quiet wrong number
 * this project is meant to avoid.
 */
import type { Connector, SyncResult, SyncWindow } from "../types";
import { ingestAdSpendRows } from "./ingest";
import { metaConnector } from "./meta";
import type { AdPlatformConnector } from "./types";

export const AD_PLATFORMS: AdPlatformConnector[] = [metaConnector];

export function adPlatform(id: string): AdPlatformConnector | undefined {
  return AD_PLATFORMS.find((p) => p.platform === id);
}

export function configuredAdPlatforms(): AdPlatformConnector[] {
  return AD_PLATFORMS.filter((p) => p.isConfigured());
}

/**
 * Wrap an ad platform in the generic Connector interface used by the sync
 * scripts. Incremental deliberately re-pulls a trailing window rather than only
 * since the cursor: ad platforms restate recent days as late conversions land, so
 * a strict watermark would freeze stale numbers.
 */
export function asConnector(p: AdPlatformConnector, lookbackDays = 7): Connector {
  return {
    source: p.platform === "meta" ? "meta" : "google_ads",
    isConfigured: () => p.isConfigured(),
    healthCheck: () => p.healthCheck(),

    async backfill(window: SyncWindow): Promise<SyncResult> {
      const rows = await p.fetchSpend(window);
      const res = await ingestAdSpendRows(rows);
      return {
        source: p.platform === "meta" ? "meta" : "google_ads",
        rowsIn: res.rowsIn,
        rowsUpserted: res.rowsUpserted,
        warnings: res.warnings,
        cursor: new Date().toISOString(),
      };
    },

    async incrementalSync(sinceCursor?: string): Promise<SyncResult> {
      const lookback = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
      const since = sinceCursor
        ? new Date(Math.min(new Date(sinceCursor).getTime(), lookback.getTime()))
        : lookback;
      const rows = await p.fetchSpend({ since });
      const res = await ingestAdSpendRows(rows);
      return {
        source: p.platform === "meta" ? "meta" : "google_ads",
        rowsIn: res.rowsIn,
        rowsUpserted: res.rowsUpserted,
        warnings: res.warnings,
        cursor: new Date().toISOString(),
      };
    },
  };
}

export { metaConnector } from "./meta";
export * from "./types";

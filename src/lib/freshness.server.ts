/**
 * How current each source actually is — per source, not one number for the app.
 *
 * ## The failure this exists to prevent
 *
 * On 13 Aug 2026 the app showed $177.34 of Meta spend for 12 August. Meta showed $416.88. The
 * app was not wrong about anything it had; it had fetched 12 August at 17:51 UTC, while the
 * day was still running, and nothing had synced since. The stored figure was 43% of a day
 * presented as a whole one.
 *
 * Nothing on the page said so. `/marketing` and `/creatives` printed the partial number in the
 * same typeface as a settled one, and every ratio built on it — ROAS, MER, cost per order —
 * was silently wrong in the flattering direction, because a smaller denominator makes ads look
 * more efficient than they are.
 *
 * The date picker's "1 day behind today" did not help: that is computed from ORDERS. Orders
 * and ad spend arrive on completely different schedules, and one being current says nothing
 * about the other.
 *
 * ## Why the last day is always suspect
 *
 * Ad platforms restate recent days as late conversions land and billing settles, so the most
 * recent day in `ad_spend` is provisional by construction — even a sync that finished seconds
 * ago holds a figure Meta will revise. `lastDayProvisional` is therefore about the DATA's
 * shape, not the sync's recency, and stays true even when `ageHours` is near zero.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";

/** Beyond this, a source is stale enough to say so rather than merely note it. */
export const STALE_AFTER_HOURS = 26;

export interface SourceFreshness {
  source: string;
  /** Last run that completed, whether or not it carried warnings. */
  lastRunAt: string | null;
  /** `success` | `partial` | `failed` | null when it has never run. */
  lastStatus: string | null;
  /** Hours since that run. Null when it has never run. */
  ageHours: number | null;
  /** True past STALE_AFTER_HOURS, or when it has never run at all. */
  stale: boolean;
  /** Warnings from the most recent run — a standing capability gap shows up here. */
  warnings: string[];
  /** Most recent date present in this source's data, when the source is date-grained. */
  lastDataDate: string | null;
  /**
   * True when the newest day of data is expected to change. Ad platforms restate recent days,
   * so their last day is provisional even immediately after a sync.
   */
  lastDayProvisional: boolean;
}

/** Sources whose most recent day is restated after the fact. */
const RESTATING_SOURCES = new Set(["meta", "google_ads"]);

/**
 * Freshness for every source that has ever run.
 *
 * Deliberately reads the latest run regardless of status. Filtering to `success` is what hid
 * the Shopify cursor bug for two weeks — a run that completes with a standing warning is still
 * the most recent thing that happened, and a freshness display that ignores it reports a
 * healthy source as long dead.
 */
export async function getSourceFreshness(): Promise<SourceFreshness[]> {
  const runs = await db.execute<{
    source: string;
    status: string;
    finished_at: string | null;
    warnings: unknown;
    age_hours: number | null;
  }>(sql`
    SELECT DISTINCT ON (source)
           source, status, finished_at,
           warnings,
           EXTRACT(EPOCH FROM (now() - finished_at)) / 3600 AS age_hours
      FROM sync_runs
     WHERE finished_at IS NOT NULL
     ORDER BY source, finished_at DESC
  `);

  // Latest data date per source, for the ones that carry dated rows.
  const adDate = await db.execute<{ platform: string; last_date: string }>(sql`
    SELECT platform, max(date)::text AS last_date FROM ad_spend GROUP BY platform
  `);
  const adByPlatform = new Map([...adDate].map((r) => [r.platform, r.last_date]));

  const orderDate = await db.execute<{ last_date: string }>(sql`
    SELECT max(processed_at)::date::text AS last_date
      FROM orders WHERE test = false AND cancelled_at IS NULL
  `);
  const lastOrderDate = [...orderDate][0]?.last_date ?? null;

  return [...runs].map((r) => {
    const age = r.age_hours === null ? null : Number(r.age_hours);
    const lastDataDate =
      r.source === "shopify" ? lastOrderDate : (adByPlatform.get(r.source) ?? null);

    return {
      source: r.source,
      lastRunAt: r.finished_at,
      lastStatus: r.status,
      ageHours: age,
      stale: age === null || age > STALE_AFTER_HOURS,
      warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
      lastDataDate,
      lastDayProvisional: RESTATING_SOURCES.has(r.source) && lastDataDate !== null,
    };
  });
}

/**
 * The stale-source sentence for the banner.
 *
 * Pure and exported so it can be tested. The multi-source wording only appears while two
 * sources are behind at once — precisely the state a working auto-refresh removes — so it is
 * close to impossible to observe deliberately in a browser.
 *
 * One sentence covering all of them, because the banner used to render a paragraph per source,
 * each repeating "…is flagged because a day fetched mid-flight is stored as a whole one. Run
 * run.cmd sync." With Meta and Shopify both 27h behind it printed that twice and read like a
 * rendering bug. The source names differ; the reason and the remedy never do.
 */
export function staleSummary(stale: SourceFreshness[]): string {
  if (stale.length === 0) return "";

  if (stale.length === 1) {
    const f = stale[0];
    return f.ageHours === null
      ? `${f.source} has never synced.`
      : `${f.source} last synced ${Math.round(f.ageHours)}h ago.`;
  }

  // Oldest first, never-synced worst of all: if only the first name gets read, it should be
  // the one most worth knowing about.
  const ordered = [...stale].sort(
    (a, b) => (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity),
  );
  return `${ordered.length} sources are behind — ${ordered
    .map((f) => `${f.source} ${f.ageHours === null ? "never synced" : `${Math.round(f.ageHours)}h`}`)
    .join(", ")}.`;
}

/**
 * One-line summary for a page header.
 *
 * Names the worst offender rather than averaging: "some data is 40 hours old" is not
 * actionable, and an average across five sources hides the one that is broken.
 */
export function freshnessHeadline(all: SourceFreshness[]): string | null {
  const stale = all.filter((f) => f.stale);
  if (stale.length === 0) return null;

  const worst = stale.reduce((a, b) => ((b.ageHours ?? Infinity) > (a.ageHours ?? Infinity) ? b : a));
  const hours = worst.ageHours === null ? null : Math.round(worst.ageHours);
  const others = stale.length > 1 ? ` (and ${stale.length - 1} other source(s))` : "";

  return hours === null
    ? `${worst.source} has never synced${others}. Run \`run.cmd sync\`.`
    : `${worst.source} last synced ${hours}h ago${others}. Run \`run.cmd sync\` — figures below may be incomplete.`;
}

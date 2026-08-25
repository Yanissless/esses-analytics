/**
 * Says out loud when the numbers below might be incomplete.
 *
 * Server Component — static, so it stays off the client boundary.
 *
 * Renders NOTHING when everything is current. A banner that is always present becomes
 * furniture, and the one time it matters nobody reads it. It appears when a source is stale,
 * when the most recent run failed, or when the newest day of ad data is still provisional.
 *
 * The provisional-day note is separate from staleness on purpose: ad platforms restate recent
 * days as late conversions and billing settle, so the last day is unreliable even right after
 * a sync. Reporting only "synced 2 minutes ago" would imply a settled number.
 */

import type { SourceFreshness } from "@/lib/freshness.server";
import { STALE_AFTER_HOURS, staleSummary } from "@/lib/freshness.server";
import { RefreshButton } from "./refresh-button";

export function FreshnessBanner({
  freshness,
  /** Only report on the sources a page actually depends on. */
  sources,
}: {
  freshness: SourceFreshness[];
  sources: string[];
}) {
  const relevant = freshness.filter((f) => sources.includes(f.source));
  const stale = relevant.filter((f) => f.stale);
  const failed = relevant.filter((f) => f.lastStatus === "failed");
  const provisional = relevant.filter((f) => f.lastDayProvisional);

  if (stale.length === 0 && failed.length === 0 && provisional.length === 0) return null;

  const serious = stale.length > 0 || failed.length > 0;

  return (
    <div
      className={
        serious
          ? "rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          : "rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-400"
      }
    >
      {failed.map((f) => (
        <div key={`fail-${f.source}`}>
          <strong>{f.source} sync failed.</strong> Figures below exclude anything it would have
          brought in.
        </div>
      ))}

      {/* One line covering every stale source, explanation given once. The wording lives in
          `staleSummary` so it can be unit-tested — see the note there. */}
      {stale.length > 0 ? (
        <div>
          <strong>{staleSummary(stale)}</strong> Anything past {STALE_AFTER_HOURS}h is flagged
          because a day fetched mid-flight is stored as a whole one.{" "}
          <span className="ml-1 inline-block align-middle">
            <RefreshButton
              label="Update now"
              className="rounded-md border border-amber-400 px-2 py-0.5 text-xs font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
            />
          </span>
        </div>
      ) : null}

      {provisional.length > 0 ? (
        <div className={serious ? "mt-1.5 text-xs" : ""}>
          {provisional.map((f) => f.source).join(", ")}: the most recent day (
          {provisional.map((f) => f.lastDataDate).filter(Boolean).join(", ")}) is{" "}
          <strong>provisional</strong> — ad platforms restate recent days as late conversions
          and billing settle, so it will move even without a sync. A partial day makes ads look
          more efficient than they are, because the spend denominator is short.
        </div>
      ) : null}
    </div>
  );
}

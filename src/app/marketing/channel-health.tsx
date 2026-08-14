/**
 * Channel health cards — the red/amber/green surface from StoreHero.
 *
 * Server Component: no interaction beyond the InfoTip, which is itself CSS-only, so this
 * stays off the client boundary where the serialization trap lives.
 *
 * ## The dot is never the only signal
 *
 * Each status carries a word as well as a colour, and the reason sentence is always rendered.
 * A grid of coloured dots is unreadable in greyscale, unreadable to a colour-blind reader, and
 * — more practically — tells nobody WHY a channel is amber, which is the only part that leads
 * to an action.
 */

import { Card, Caveat, formatNum, formatUsd } from "../_components/ui";
import type { ChannelHealth, HealthStatus, MetricComparison } from "@/metrics/channel-health";
import { MIN_CONVERSIONS_TO_GRADE } from "@/metrics/channel-health";

const STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: "Healthy",
  watch: "Watch",
  "at-risk": "At risk",
  insufficient: "Not enough data",
};

const STATUS_DOT: Record<HealthStatus, string> = {
  healthy: "bg-emerald-500",
  watch: "bg-amber-500",
  "at-risk": "bg-red-500",
  insufficient: "bg-neutral-300 dark:bg-neutral-600",
};

const STATUS_TEXT: Record<HealthStatus, string> = {
  healthy: "text-emerald-700 dark:text-emerald-400",
  watch: "text-amber-700 dark:text-amber-400",
  "at-risk": "text-red-700 dark:text-red-400",
  insufficient: "text-neutral-500 dark:text-neutral-400",
};

const CHANNEL_LABEL: Record<string, string> = {
  "paid-meta": "Meta ads",
  "paid-google": "Google ads",
  "paid-tiktok": "TikTok ads",
  "paid-other": "Other paid",
  "organic-social": "Organic social",
  "organic-search": "Organic search",
  newsletter: "Newsletter",
  direct: "Direct",
  referral: "Referral",
  internal: "Internal",
  "social-unknown": "Social (unattributed)",
};

function fmtValue(key: string, v: number | null): string {
  if (v === null) return "—";
  if (key === "roas") return `${v.toFixed(2)}×`;
  if (key === "cac") return formatUsd(v);
  if (key === "revenue" || key === "spend") return formatUsd(v, { compact: true });
  return formatNum(Math.round(v));
}

/**
 * The change figure.
 *
 * Coloured by whether the movement is GOOD for that metric, not by its sign — so a falling
 * CAC is green while a falling ROAS is red, and nobody has to remember which way round each
 * metric reads.
 */
function Change({ m }: { m: MetricComparison }) {
  if (m.change === null) {
    return <span className="text-neutral-400">—</span>;
  }
  const good = m.polarity === "higher-is-better" ? m.change > 0 : m.change < 0;
  const flat = Math.abs(m.change) < 0.005;
  const pct = `${m.change >= 0 ? "+" : "−"}${Math.round(Math.abs(m.change) * 100)}%`;

  // Spend is shown but never judged, so it stays neutral whichever way it moved.
  const tone =
    m.key === "spend" || flat
      ? "text-neutral-500 dark:text-neutral-400"
      : good
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";

  return <span className={`tabular-nums ${tone}`}>{pct}</span>;
}

function ChannelCard({ health: h }: { health: ChannelHealth }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{CHANNEL_LABEL[h.channel] ?? h.channel}</div>
          <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            {formatUsd(h.spendCents, { compact: true })} spend ·{" "}
            {formatNum(h.conversions)} conversions
          </div>
        </div>
        <span className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${STATUS_TEXT[h.status]}`}>
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[h.status]}`} aria-hidden />
          {STATUS_LABEL[h.status]}
        </span>
      </div>

      <table className="mt-3 w-full text-xs">
        <thead className="text-neutral-400">
          <tr>
            <th className="pb-1 text-left font-medium">Metric</th>
            <th className="pb-1 text-right font-medium">Now</th>
            <th className="pb-1 text-right font-medium">Prev</th>
            <th className="pb-1 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="text-neutral-700 dark:text-neutral-300">
          {h.metrics.map((m) => (
            <tr key={m.key} className="border-t border-neutral-100 dark:border-neutral-800">
              <td className="py-1">{m.label}</td>
              <td className="py-1 text-right tabular-nums">{fmtValue(m.key, m.current)}</td>
              <td className="py-1 text-right tabular-nums text-neutral-400">
                {fmtValue(m.key, m.previous)}
              </td>
              <td className="py-1 text-right">
                <Change m={m} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {h.reason}
      </p>
    </div>
  );
}

export function ChannelHealthGrid({ health }: { health: ChannelHealth[] }) {
  return (
    <Card
      title="Channel health"
      subtitle="Worst first. Graded against the previous period of equal length."
      info={
        <>
          <strong>Why not year-on-year?</strong> The data starts 1 Oct 2025, so a
          &ldquo;last 28 days&rdquo; window compares to Jul&ndash;Aug 2025, where there is
          nothing. YoY columns would be blank for every range anyone actually looks at until
          Oct 2026 — and a blank column that quietly starts meaning something later is worse
          than no column, because nobody notices the day it changes. This will gain a YoY mode
          once there are two full years.
        </>
      }
    >
      {health.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No channel activity in this range.
        </p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {health.map((h) => (
              <ChannelCard key={h.channel} health={h} />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
            <Caveat summary={`Channels under ${MIN_CONVERSIONS_TO_GRADE} conversions are not graded`}>
              A channel with a handful of conversions can swing hundreds of percent between
              periods on noise. Grading that produces confident red lights on nothing, and red
              lights that turn out to be noise are how people learn to ignore red lights.
            </Caveat>

            <Caveat summary="Spend is shown but never graded">
              Spending more is neither good nor bad on its own — it is the input whose
              efficiency ROAS and CAC measure. Grading it would mark a deliberate scale-up as a
              problem.
            </Caveat>

            <Caveat summary="Switched-off channels are dropped, not shown collapsing">
              A channel present last period and absent now would read as −100%. &ldquo;We
              turned it off&rdquo; and &ldquo;it collapsed&rdquo; are identical in the numbers,
              so it is left out rather than guessed at.
            </Caveat>
          </div>
        </>
      )}
    </Card>
  );
}

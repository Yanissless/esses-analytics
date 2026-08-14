import type { ReactNode } from "react";
import { isGood, type Delta, type MetricPolarity } from "@/lib/date-range";

export function formatUsd(cents: number, opts: { compact?: boolean } = {}): string {
  const dollars = cents / 100;
  if (opts.compact && Math.abs(dollars) >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(dollars);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

export const formatNum = (n: number): string => new Intl.NumberFormat("en-US").format(n);

/**
 * Period-over-period change, shown beside a stat.
 *
 * Two things this gets right that comparison UIs routinely get wrong:
 *
 * **Colour follows the metric, not the arrow.** CAC rising is bad; MER rising is good. Every
 * call site declares its `polarity`, so nobody learns to skim for green and then reads CAC
 * backwards. There is no default — an unlabelled metric would silently inherit
 * higher-is-better, which is wrong for half the numbers on the Marketing page.
 *
 * **A null percentage renders as the absolute change, not as 0% or ∞.** Growth from a base
 * of zero has no percentage (rule 3), and both of the obvious placeholders are misleading:
 * 0% says nothing happened, ∞ is not a figure anyone can act on.
 */
export function DeltaBadge({
  delta,
  polarity,
  format,
  compareLabel,
}: {
  delta: Delta | null;
  polarity: MetricPolarity;
  /** Renders the absolute change in the metric's own units (dollars, ratios, counts). */
  format: (n: number) => string;
  /** e.g. "vs previous 28 days" — shown as a tooltip so the tile stays readable. */
  compareLabel?: string;
}) {
  if (!delta) return null;

  const good = isGood(delta, polarity);
  const tone =
    good === null
      ? "text-neutral-400"
      : good
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";
  const arrow = delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "■";
  const magnitude =
    delta.pct === null
      ? format(Math.abs(delta.absolute))
      : `${Math.abs(delta.pct * 100).toFixed(1)}%`;

  return (
    <span className={`inline-flex items-baseline gap-1 text-xs ${tone}`} title={compareLabel}>
      <span aria-hidden>{arrow}</span>
      <span className="tabular-nums">{magnitude}</span>
      {delta.pct === null && delta.direction !== "flat" ? (
        // Says why there is no percentage, rather than leaving a bare number looking like one.
        <span className="text-neutral-400">from zero</span>
      ) : null}
    </span>
  );
}

/**
 * A small `i` that reveals an explanation on hover or focus.
 *
 * ## Why this exists
 *
 * Every number in this app needs a caveat — which margin boundary, what the denominator is,
 * which population is being compared, how much of the data attribution can actually see. The
 * first version of every page printed those caveats as prose, and the result was pages where
 * three paragraphs of hedging sat above the figures they were hedging. Sam's read: "too
 * cluttered and not as clean looking as StoreHero". Correct.
 *
 * The caveats are not optional — a margin quoted without its boundary is the thing this
 * codebase exists to prevent — so they cannot simply be deleted. They move here instead:
 * present, one click or hover away, and out of the way until wanted.
 *
 * ## Keyboard and screen readers
 *
 * The trigger is a real `<button>`, so `group-focus-within` reveals the panel on tab as well
 * as hover. A hover-only CSS tooltip is unreachable by keyboard, and `display:none` would
 * take the content out of the accessibility tree entirely — hence visibility plus opacity,
 * which animates and still hides from assistive tech when closed.
 *
 * `pointer-events-none` on the panel matters: without it the panel can sit under the cursor
 * on its way elsewhere and flicker the hover state on and off.
 */
export function InfoTip({
  children,
  label = "More information",
  align = "left",
  width = "20rem",
}: {
  children: ReactNode;
  label?: string;
  /** Which edge the panel is anchored to. Use `right` near the right edge of a container. */
  align?: "left" | "right";
  width?: string;
}) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-300 text-[10px] font-medium leading-none text-neutral-500 transition hover:border-neutral-500 hover:text-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-400 dark:hover:text-neutral-100"
      >
        i
      </button>
      <span
        role="tooltip"
        style={{ width }}
        className={`pointer-events-none invisible absolute top-6 z-30 rounded-lg border border-neutral-200 bg-white p-3 text-xs font-normal leading-relaxed text-neutral-600 opacity-0 shadow-lg transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {children}
      </span>
    </span>
  );
}

/**
 * A caveat line: one short sentence, with the detail behind an `InfoTip`.
 *
 * The summary has to stand alone. Someone who never hovers should still come away with the
 * right impression — so the summary carries the warning and the tip carries the reasoning,
 * rather than the summary being a teaser that means nothing without the tip.
 */
export function Caveat({
  summary,
  children,
  tone = "neutral",
}: {
  summary: string;
  children?: ReactNode;
  tone?: "neutral" | "warn";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${
        tone === "warn"
          ? "text-amber-700 dark:text-amber-400"
          : "text-neutral-500 dark:text-neutral-400"
      }`}
    >
      {summary}
      {children ? <InfoTip>{children}</InfoTip> : null}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  children,
  className = "",
  /** Detail behind an InfoTip on the header, for context that used to be a prose block. */
  info,
  /** Right-aligned header slot — a filter, a count, a status pill. */
  action,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  info?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      className={`rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
    >
      {title ? (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {title}
              {info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{subtitle}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  emphasis = false,
  trailing,
  target,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  /** Sits on the value's baseline — a `DeltaBadge`, typically. */
  trailing?: ReactNode;
  /** Sits below the hint — a `TargetBadge`, typically. Absent when no target is set. */
  target?: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl p-4 ${
        emphasis
          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          : "bg-neutral-100/70 dark:bg-neutral-800/60"
      }`}
    >
      <div
        className={`text-xs ${
          emphasis
            ? "text-neutral-300 dark:text-neutral-600"
            : "text-neutral-500 dark:text-neutral-400"
        }`}
      >
        {label}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-medium tabular-nums tracking-tight">{value}</span>
        {trailing}
      </div>
      {hint ? (
        <div
          className={`mt-1 text-xs ${
            emphasis
              ? "text-neutral-400 dark:text-neutral-600"
              : "text-neutral-500 dark:text-neutral-400"
          }`}
        >
          {hint}
        </div>
      ) : null}
      {target ? <div className="mt-2">{target}</div> : null}
    </div>
  );
}

/**
 * The "5% AHEAD OF TARGET" / "10% BEHIND TARGET" pill.
 *
 * Three rules it exists to enforce, all of which are easy to get wrong in a way that reads as
 * confident rather than broken:
 *
 *  1. **No target set renders nothing.** Not a grey "0%", not "—". A tile with no pill says
 *     "nobody set a target for this"; a pill showing 0% says "you have hit none of it".
 *  2. **The comparison is pace-adjusted.** Against a whole month's target, every metric is
 *     catastrophically behind on the 3rd. The caller passes a variance already pro-rated by
 *     elapsed time — see `paceVariance`.
 *  3. **Colour is never the only channel.** The words "ahead"/"behind" carry the meaning, so
 *     it survives greyscale printing and colour blindness. Same rule as the charts.
 *
 * `polarity` matters because down is good for some metrics. Being 10% "behind" a CAC target
 * is a win, and a red pill there trains people to ignore red.
 */
export function TargetBadge({
  variance,
  polarity = "higher-is-better",
  label = "target",
}: {
  /** Pro-rated variance: +0.05 is 5% ahead. Null when no target is set — renders nothing. */
  variance: number | null;
  polarity?: "higher-is-better" | "lower-is-better";
  label?: string;
}) {
  if (variance === null || !Number.isFinite(variance)) return null;

  const ahead = polarity === "higher-is-better" ? variance >= 0 : variance <= 0;
  const pct = Math.abs(variance) * 100;
  // Under half a percent, "0% ahead" is noise dressed as a signal.
  const text =
    pct < 0.5
      ? `ON ${label.toUpperCase()}`
      : `${pct.toFixed(0)}% ${ahead ? "AHEAD OF" : "BEHIND"} ${label.toUpperCase()}`;

  const tone =
    pct < 0.5
      ? "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
      : ahead
        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";

  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${tone}`}
    >
      {text}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "amber" | "emerald" | "blue";
}) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  } as const;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

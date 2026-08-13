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

export function Card({
  title,
  subtitle,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
    >
      {title ? (
        <header className="mb-4">
          <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{subtitle}</p>
          ) : null}
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
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  /** Sits on the value's baseline — a `DeltaBadge`, typically. */
  trailing?: ReactNode;
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
    </div>
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

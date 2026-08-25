"use client";

/**
 * The date range control. One instance per page, directly under the heading.
 *
 * ⚠️ Imports only `@/lib/date-range` — the pure half. `date-range.server.ts` reads the
 * database and must never reach the client bundle (rule 6).
 *
 * State lives in the URL, not in this component: it writes `?range=…&compare=…` and the
 * server component re-renders from those params. That keeps one source of truth, makes a
 * range shareable with the team, and means the back button works. The cost is a round trip
 * per change, which for a dashboard is the right trade — the alternative is shipping every
 * page's data for every range to the client.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  RANGE_PRESETS,
  type CompareMode,
  type RangePreset,
} from "@/lib/date-range";

const COMPARE_OPTIONS: Array<{ id: CompareMode; label: string; hint: string }> = [
  { id: "previous", label: "vs previous", hint: "The window of equal length immediately before this one." },
  { id: "year", label: "vs last year", hint: "The same dates a year earlier. Unavailable where the data doesn't reach back." },
  { id: "none", label: "no comparison", hint: "Show the period on its own." },
];

export function DateRangePicker({
  preset,
  compareMode,
  since,
  until,
  anchor,
  dataStart,
  lagDays,
  /** Set when the resolved comparison is null, so the control can say why. */
  comparisonUnavailable = false,
}: {
  preset: RangePreset;
  compareMode: CompareMode;
  since: string;
  until: string;
  anchor: string;
  dataStart: string;
  lagDays: number;
  comparisonUnavailable?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(next: Record<string, string | null>) {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    startTransition(() => router.push(`${pathname}?${q.toString()}`, { scroll: false }));
  }

  const isCustom = preset === "custom";

  return (
    <div
      className={`rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900 ${
        pending ? "opacity-60" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              aria-pressed={preset === p.id}
              onClick={() => update({ range: p.id, since: null, until: null })}
              className={`rounded-lg px-2.5 py-1.5 text-xs transition ${
                preset === p.id
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            title="Pick exact dates."
            aria-pressed={isCustom}
            onClick={() => update({ range: "custom", since, until })}
            className={`rounded-lg px-2.5 py-1.5 text-xs transition ${
              isCustom
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            Custom
          </button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          {COMPARE_OPTIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              title={c.hint}
              aria-pressed={compareMode === c.id}
              onClick={() => update({ compare: c.id })}
              className={`rounded-lg px-2.5 py-1.5 text-xs transition ${
                compareMode === c.id
                  ? "border border-neutral-400 text-neutral-900 dark:border-neutral-500 dark:text-neutral-100"
                  : "text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {isCustom && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3 text-xs dark:border-neutral-800">
          {/* min/max bound the pickers to days the data covers, so an impossible range
              cannot be chosen in the first place. */}
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            From
            <input
              type="date"
              value={since}
              min={dataStart}
              max={anchor}
              onChange={(e) => update({ range: "custom", since: e.target.value })}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </label>
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            to
            <input
              type="date"
              value={until}
              min={dataStart}
              max={anchor}
              onChange={(e) => update({ range: "custom", until: e.target.value })}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </label>
          <span className="text-neutral-400">
            data covers {dataStart} → {anchor}
          </span>
        </div>
      )}

      {/* The honesty line. Presets end at the last day with DATA, not today — without saying
          so, "last 7 days" looks like it includes days the sync hasn't reached yet. */}
      <p className="mt-2 text-[11px] text-neutral-400">
        Ranges end on {anchor}, the most recent day with data
        {lagDays > 0
          ? ` — ${lagDays} day${lagDays === 1 ? "" : "s"} behind today, so "last 7 days" means the last 7 days of data, not of the calendar. Use the "Update now" button to close the gap.`
          : ", which is today."}
        {comparisonUnavailable && compareMode !== "none"
          ? compareMode === "year"
            ? " No year-on-year comparison: the data doesn't reach back that far."
            : " No previous period to compare against: this range already starts at the first day of data."
          : ""}
      </p>
    </div>
  );
}

/**
 * Date ranges and period-over-period comparison.
 *
 * Pure and dependency-free, so the picker (a `"use client"` component) and the pages (server
 * components) share one definition of what "last 28 days" means. Rule 6.
 *
 * ## Two decisions that make or break this
 *
 * **1. Presets anchor to the last day with DATA, not to today.** This is the important one.
 * The metrics tables lag live data by whenever the sync last ran, so "last 7 days" measured
 * from today can include days that are empty simply because nothing has been ingested yet.
 * Those days aren't zero-revenue days; they're unknown days — and averaging them in makes a
 * healthy week look like a collapse. `getGoalProgress` already carries this warning for
 * forecasting ("projecting from a date later than the last synced day would silently treat
 * missing days as zeros and tank the estimate"); a date picker is the same hazard with a
 * bigger blast radius, because it would misprice every metric on the page at once.
 *
 * So `resolveRange` takes an explicit `anchor` — pass the last date the data actually
 * covers — and every preset ends there. `dataLagDays` exists so the UI can say "through
 * 12 Aug" rather than implying the range runs to now.
 *
 * **2. The comparison period is the immediately preceding window of EQUAL LENGTH.** Not
 * "last month" or "last quarter" as calendar units. This matters for partial periods: on the
 * 12th of the month, month-to-date is 12 days, and comparing it to a full 31-day previous
 * month shows a fake 60% collapse. Comparing to the preceding 12 days is like-for-like.
 * It is the single most common way a period comparison lies, and the fix is to define the
 * comparison by duration rather than by calendar name.
 */

// ---------------------------------------------------------------------------
// Day arithmetic on YYYY-MM-DD strings, in UTC
// ---------------------------------------------------------------------------

/**
 * All arithmetic is UTC. Using local time would shift a boundary by a day for anyone west
 * of Greenwich and make the same preset return different ranges for different viewers.
 */
const DAY_MS = 86_400_000;

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function toMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return toIso(toMs(iso) + n * DAY_MS);
}

/** Inclusive day count: the same date twice is 1 day, not 0. */
export function daysInclusive(since: string, until: string): number {
  return Math.round((toMs(until) - toMs(since)) / DAY_MS) + 1;
}

/** First of the month / quarter / year containing `iso`. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function startOfQuarter(iso: string): string {
  const month = Number(iso.slice(5, 7));
  const firstMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return `${iso.slice(0, 4)}-${String(firstMonth).padStart(2, "0")}-01`;
}

export function startOfYear(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type RangePreset =
  | "7d"
  | "28d"
  | "90d"
  | "mtd"
  | "qtd"
  | "ytd"
  | "12m"
  | "all"
  | "custom";

export interface PresetMeta {
  id: RangePreset;
  label: string;
  /** Shown as a tooltip; states the anchor so nobody assumes "to today". */
  hint: string;
}

/**
 * Display order. Deliberately short — a picker with twenty presets is a picker nobody reads,
 * and any window these don't cover is what `custom` is for.
 */
export const RANGE_PRESETS: PresetMeta[] = [
  { id: "7d", label: "7 days", hint: "The last 7 days of data, ending on the most recent day with data." },
  { id: "28d", label: "28 days", hint: "The last 28 days of data. Four whole weeks, so weekday effects cancel." },
  { id: "90d", label: "90 days", hint: "The last 90 days of data." },
  { id: "mtd", label: "Month to date", hint: "1st of the current month through the most recent day with data." },
  { id: "qtd", label: "Quarter to date", hint: "Start of the current quarter through the most recent day with data." },
  { id: "ytd", label: "Year to date", hint: "1 January through the most recent day with data." },
  { id: "12m", label: "12 months", hint: "The last 365 days of data." },
  { id: "all", label: "All time", hint: "Every day the data covers." },
];

export function isRangePreset(v: unknown): v is RangePreset {
  return (
    typeof v === "string" &&
    ["7d", "28d", "90d", "mtd", "qtd", "ytd", "12m", "all", "custom"].includes(v)
  );
}

export interface ResolvedRange {
  preset: RangePreset;
  since: string;
  until: string;
  days: number;
  /** Human label for the header, e.g. "Last 28 days · 16 Jul – 12 Aug 2026". */
  label: string;
  /**
   * True when the requested window was clipped because the data starts later. A 12-month
   * view of ten months of data is ten months, and saying so stops the missing two months
   * being read as a decline.
   */
  clippedToDataStart: boolean;
}

export interface ResolveOptions {
  /** The most recent day the data actually covers. Every preset ends here — see the note above. */
  anchor: string;
  /** The first day the data covers. Ranges are clipped to it rather than inventing empty days. */
  dataStart: string;
  since?: string;
  until?: string;
}

/**
 * Turns a preset (or an explicit custom window) into concrete dates.
 *
 * Always returns a usable range: an unparseable custom window falls back to the preset's
 * default rather than throwing, because a bad URL should render a page, not a stack trace.
 */
export function resolveRange(preset: RangePreset, opts: ResolveOptions): ResolvedRange {
  const { anchor, dataStart } = opts;

  let since: string;
  const until = preset === "custom" && isIsoDate(opts.until) ? opts.until : anchor;

  switch (preset) {
    case "7d":
      since = addDays(until, -6);
      break;
    case "28d":
      since = addDays(until, -27);
      break;
    case "90d":
      since = addDays(until, -89);
      break;
    case "12m":
      since = addDays(until, -364);
      break;
    case "mtd":
      since = startOfMonth(until);
      break;
    case "qtd":
      since = startOfQuarter(until);
      break;
    case "ytd":
      since = startOfYear(until);
      break;
    case "custom":
      since = isIsoDate(opts.since) ? opts.since : addDays(until, -27);
      break;
    case "all":
    default:
      since = dataStart;
      break;
  }

  // Never claim to cover days before the data begins.
  const clipped = since < dataStart;
  if (clipped) since = dataStart;
  // A custom range given backwards is a typo, not an instruction.
  const orderedSince = since <= until ? since : until;

  return {
    preset,
    since: orderedSince,
    until,
    days: daysInclusive(orderedSince, until),
    label: `${labelFor(preset)} · ${formatRange(orderedSince, until)}`,
    clippedToDataStart: clipped,
  };
}

function labelFor(preset: RangePreset): string {
  if (preset === "custom") return "Custom";
  return RANGE_PRESETS.find((p) => p.id === preset)?.label ?? "All time";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "16 Jul – 12 Aug 2026", collapsing a shared year and a shared month. */
export function formatRange(since: string, until: string): string {
  const [ys, ms, ds] = since.split("-").map(Number);
  const [yu, mu, du] = until.split("-").map(Number);
  if (since === until) return `${ds} ${MONTHS[ms - 1]} ${ys}`;
  if (ys !== yu) return `${ds} ${MONTHS[ms - 1]} ${ys} – ${du} ${MONTHS[mu - 1]} ${yu}`;
  if (ms !== mu) return `${ds} ${MONTHS[ms - 1]} – ${du} ${MONTHS[mu - 1]} ${yu}`;
  return `${ds}–${du} ${MONTHS[mu - 1]} ${yu}`;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type CompareMode = "none" | "previous" | "year";

export interface Comparison {
  mode: CompareMode;
  since: string;
  until: string;
  label: string;
  /**
   * True when the comparison window reaches back before the data starts, so it covers fewer
   * days than the current range. A shorter window compared against a longer one is not a
   * decline; it is missing data, and every delta computed from it is meaningless.
   */
  partial: boolean;
}

/**
 * The window to compare against, or null when there isn't a usable one.
 *
 * `previous` is the immediately preceding window of the same length — see the partial-period
 * note at the top of the file for why that, and not "last calendar month".
 *
 * `year` is the same dates a year earlier. Returns null when the data doesn't reach back that
 * far, which for this business is most of the time: orders begin 2025-10-01, so a
 * year-on-year view is unavailable for anything before October 2026. Null rather than a
 * truncated window, because "revenue doubled year on year" computed against two months of
 * data is worse than no answer.
 */
export function comparisonFor(
  mode: CompareMode,
  range: ResolvedRange,
  dataStart: string,
): Comparison | null {
  if (mode === "none") return null;

  if (mode === "year") {
    const since = shiftYear(range.since, -1);
    const until = shiftYear(range.until, -1);
    // Require the whole comparison window to exist, not just its tail.
    if (until < dataStart) return null;
    return {
      mode,
      since,
      until,
      label: `vs ${formatRange(since, until)}`,
      partial: since < dataStart,
    };
  }

  const until = addDays(range.since, -1);
  const since = addDays(until, -(range.days - 1));
  if (until < dataStart) return null;
  return {
    mode,
    since: since < dataStart ? dataStart : since,
    until,
    label: `vs previous ${range.days} day${range.days === 1 ? "" : "s"}`,
    partial: since < dataStart,
  };
}

/** Same month and day, N years off. 29 Feb lands on 28 Feb in a non-leap year. */
export function shiftYear(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const targetYear = y + years;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  const day = Math.min(d, daysInTargetMonth);
  return `${targetYear}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export interface Delta {
  absolute: number;
  /** Null when the previous value is 0 — rule 3. Growth from nothing has no percentage. */
  pct: number | null;
  direction: "up" | "down" | "flat";
}

/**
 * Change from `previous` to `current`.
 *
 * `pct` is null when the previous value is zero. "Up 100%" from a base of zero is not a
 * percentage, and rendering ∞ or 0 both mislead — the UI shows the absolute change instead.
 * `direction` is still meaningful in that case, which is why it is separate.
 */
export function delta(current: number, previous: number): Delta {
  const absolute = current - previous;
  return {
    absolute,
    pct: previous === 0 ? null : absolute / previous,
    direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
  };
}

/**
 * Whether a rise is good news. Not all of them are.
 *
 * CAC going up is bad; MER going up is good. A comparison UI that paints every increase
 * green teaches people to skim for colour and read CAC backwards, so each metric declares
 * its own polarity at the call site.
 */
export type MetricPolarity = "higher-is-better" | "lower-is-better";

export function isGood(d: Delta, polarity: MetricPolarity): boolean | null {
  if (d.direction === "flat") return null;
  return polarity === "higher-is-better" ? d.direction === "up" : d.direction === "down";
}

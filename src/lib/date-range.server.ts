/**
 * Resolves a date range from URL search params, anchored to the data.
 *
 * Server-only: reads the database for the window the data actually covers. The pure half is
 * `date-range.ts`, which the picker imports — rule 6.
 *
 * The range lives in the URL (`?range=28d`, `?compare=previous`) rather than in component
 * state, for three reasons that all matter here: a server component can read it without any
 * client round-trip, a link to "marketing, last 28 days, vs previous" is shareable with the
 * team, and the back button behaves. It also means the AI analyst could be handed the same
 * URL shape later without a second notion of what a range is.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  comparisonFor,
  isIsoDate,
  isRangePreset,
  resolveRange,
  type Comparison,
  type CompareMode,
  type RangePreset,
  type ResolvedRange,
} from "./date-range";

export interface DataBounds {
  /** First day covered by countable orders. */
  start: string;
  /** Last day covered — every preset ends here rather than at today. */
  anchor: string;
  /** Whole days between the anchor and today. Non-zero means the sync is behind. */
  lagDays: number;
}

/**
 * The window the data actually covers.
 *
 * Reads countable orders with the same filters the metrics use, so the picker can never offer
 * a range the numbers cannot honour. Falls back to a sane window on an empty database rather
 * than returning nulls every caller would have to handle.
 */
export async function getDataBounds(): Promise<DataBounds> {
  const rows = (await db.execute<{ first_day: string | null; last_day: string | null; today: string }>(sql`
    SELECT to_char(min(processed_at)::date, 'YYYY-MM-DD') AS first_day,
           to_char(max(processed_at)::date, 'YYYY-MM-DD') AS last_day,
           to_char(now()::date, 'YYYY-MM-DD')             AS today
      FROM orders
     WHERE test = false AND cancelled_at IS NULL AND counts_as_revenue = true
  `)) as unknown as Array<{ first_day: string | null; last_day: string | null; today: string }>;

  const r = rows[0];
  const today = r?.today ?? new Date().toISOString().slice(0, 10);
  const start = r?.first_day ?? today;
  const anchor = r?.last_day ?? today;
  const lagDays = Math.max(
    0,
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000),
  );
  return { start, anchor, lagDays };
}

/** What a page receives from Next for `?range=…&compare=…&since=…&until=…`. */
export type RangeSearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export interface PageRange {
  range: ResolvedRange;
  comparison: Comparison | null;
  compareMode: CompareMode;
  bounds: DataBounds;
}

/**
 * One call for a page to get everything it needs.
 *
 * Defaults to 28 days rather than all-time: four whole weeks cancels weekday effects, and a
 * default of all-time is what made every number on every page static until now. `compare`
 * defaults to the previous period, because a figure with no baseline is the thing people
 * squint at and guess about.
 *
 * Unknown or malformed params fall back silently — a hand-edited URL should render.
 */
export async function resolvePageRange(
  searchParams: RangeSearchParams,
  fallbackPreset: RangePreset = "28d",
): Promise<PageRange> {
  const bounds = await getDataBounds();

  const rawRange = first(searchParams.range);
  const preset: RangePreset = isRangePreset(rawRange) ? rawRange : fallbackPreset;

  const rawSince = first(searchParams.since);
  const rawUntil = first(searchParams.until);
  const range = resolveRange(preset, {
    anchor: bounds.anchor,
    dataStart: bounds.start,
    since: isIsoDate(rawSince) ? rawSince : undefined,
    until: isIsoDate(rawUntil) ? rawUntil : undefined,
  });

  const rawCompare = first(searchParams.compare);
  const compareMode: CompareMode =
    rawCompare === "none" || rawCompare === "previous" || rawCompare === "year"
      ? rawCompare
      : "previous";

  return {
    range,
    comparison: comparisonFor(compareMode, range, bounds.start),
    compareMode,
    bounds,
  };
}

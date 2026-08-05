/**
 * Server-only half of the margin boundary: the SQL predicates and the settings read.
 *
 * Split from `margin-boundary.ts` because that module is imported by the client-side
 * settings form. Anything importing drizzle or the DB client from a `"use client"`
 * file pulls the Postgres driver into the browser bundle and the build fails with
 * `Module not found: Can't resolve 'fs'`. Keep this file out of client components.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import {
  DEFAULT_MARGIN_BOUNDARY,
  isMarginBoundary,
  type MarginBoundary,
} from "./margin-boundary";

/**
 * SQL predicate selecting the rows whose COSTS count, given a boundary.
 *
 * Written against a bare `revenue_class` column, so the caller must expose one —
 * every consumer reads it from `order_profit`, the single authority.
 */
export function boundaryCostFilter(boundary: MarginBoundary): SQL {
  switch (boundary) {
    case "paid_only":
      return sql`revenue_class = 'paid'`;
    case "exclude_comps":
      return sql`revenue_class <> 'comp'`;
    case "all_classes":
      return sql`true`;
  }
}

/** Same predicate, qualified with a table alias. */
export function boundaryCostFilterFor(alias: string, boundary: MarginBoundary): SQL {
  // Alias is always a literal from our own code, never user input.
  const a = sql.raw(alias);
  switch (boundary) {
    case "paid_only":
      return sql`${a}.revenue_class = 'paid'`;
    case "exclude_comps":
      return sql`${a}.revenue_class <> 'comp'`;
    case "all_classes":
      return sql`true`;
  }
}

/**
 * The configured boundary, from the most recent `margin_settings` row.
 *
 * Falls back to the default rather than throwing when no row exists or the column
 * holds something unexpected, so a fresh or hand-edited database still renders.
 */
export async function getMarginBoundary(): Promise<MarginBoundary> {
  const rows = (await db.execute(sql`
    SELECT margin_boundary FROM margin_settings
     ORDER BY effective_date DESC LIMIT 1
  `)) as unknown as Array<{ margin_boundary: string | null }>;
  const v = rows[0]?.margin_boundary;
  return isMarginBoundary(v) ? v : DEFAULT_MARGIN_BOUNDARY;
}

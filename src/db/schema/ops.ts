import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { pk } from "./_shared";
import { syncMode, syncStatus } from "./enums";

/**
 * Every sync run is logged here (Section 6/14) so failures are debuggable and
 * re-runs are safe. `source` is free text matching ConnectorSource (shopify,
 * skio, stripe, meta, google_ads, mailgun, onsite) — avoids enum churn as new
 * sources are added. A failed run should also fire a Slack alert (Section 14).
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: pk(),
    source: text("source").notNull(),
    mode: syncMode("mode").notNull(),
    status: syncStatus("status").notNull().default("running"),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    rowsIn: integer("rows_in").notNull().default(0),
    rowsUpserted: integer("rows_upserted").notNull().default(0),

    windowSince: timestamp("window_since", { withTimezone: true }),
    windowUntil: timestamp("window_until", { withTimezone: true }),
    cursor: text("cursor"),

    error: text("error"),
    warnings: jsonb("warnings").$type<string[]>(),
  },
  (t) => [
    index("sync_runs_source_started_idx").on(t.source, t.startedAt),
    index("sync_runs_status_idx").on(t.status),
  ],
);

export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;

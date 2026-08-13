/**
 * Generic connector contract.
 *
 * Every data source (Shopify, Skio, Stripe, Meta, Mailgun, future ad platforms)
 * implements this interface. Adding a new source is then a matter of writing one
 * module that satisfies `Connector` plus adding its credentials to env — not
 * touching the sync scheduler or the rest of the app.
 *
 * Two sync modes, per Section 3 of the brief:
 *   - backfill:    historical load over a date window (idempotent, resumable)
 *   - incremental: catch-up since the last successful sync (webhook or poll)
 *
 * All runs are logged to the `sync_runs` table (see src/db/schema) so failures
 * are debuggable and re-runs are safe.
 */

export type ConnectorSource =
  | "shopify"
  | "skio"
  | "stripe"
  | "meta"
  /** Instagram organic audience — distinct from "meta", which is paid ads. */
  | "instagram"
  | "google_ads"
  | "mailgun"
  | "onsite";

export interface SyncWindow {
  /** Inclusive start of the window to sync. */
  since: Date;
  /** Exclusive end; defaults to "now" when omitted. */
  until?: Date;
}

export interface SyncResult {
  source: ConnectorSource;
  /** Rows read from the upstream API / file. */
  rowsIn: number;
  /** Rows inserted or updated in our store. */
  rowsUpserted: number;
  /** Non-fatal issues (e.g. skipped malformed rows). */
  warnings: string[];
  /** Opaque cursor/watermark to resume the next incremental sync. */
  cursor?: string;
}

export interface Connector {
  readonly source: ConnectorSource;

  /** True when the required credentials are present. */
  isConfigured(): boolean;

  /** Cheap credential/permission check without mutating anything. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;

  /** Full historical load over a window. Must be idempotent (safe to re-run). */
  backfill(window: SyncWindow): Promise<SyncResult>;

  /** Catch-up since the last successful sync. */
  incrementalSync(sinceCursor?: string): Promise<SyncResult>;
}

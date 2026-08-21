/**
 * Turning a GA4 report into rows we can store — the parts worth testing without a network.
 *
 * Kept separate from the client so the reshaping rules are unit-testable. Every function here
 * is pure; anything that talks to Google lives in `client.ts`.
 */

/** GA4's `(other)` bucket. Appears as a literal dimension value, not a flag on the row. */
export const OTHER_ROW = "(other)";

/**
 * How long GA4 may still revise a day.
 *
 * Google documents up to 48 hours for standard properties. Rows inside this window are stored
 * with `is_provisional` set: they are real numbers that are not yet final, which is a different
 * thing from missing data and needs saying differently.
 */
export const PROCESSING_LAG_HOURS = 48;

/**
 * GA4 caps a report at 100,000 rows regardless of what you ask for.
 *
 * Set below the cap deliberately. A page size EQUAL to the cap makes "full page returned" and
 * "hit the server limit" indistinguishable, so a truncated report would look like a complete
 * one — the sort of thing that silently drops a month of the tail.
 */
export const PAGE_SIZE = 50_000;

export interface Ga4Row {
  /** GA4 returns `YYYYMMDD` for the `date` dimension. */
  date: string;
  pagePath: string;
  pageTitle?: string;
  sessions: number;
  views: number;
  users: number;
  engagedSessions: number;
  engagementSeconds: number;
  entrances: number;
}

export interface ShapedRow {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  pagePath: string;
  pageTitle: string | null;
  sessions: number;
  views: number;
  users: number;
  engagedSessions: number;
  engagementSeconds: number;
  entrances: number;
  isProvisional: boolean;
}

/** `20260821` → `2026-08-21`. Returns null for anything that isn't GA4's format. */
export function parseGa4Date(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  // Reject 2026-13-45 and friends: a bad date that parses as a string would land in the table
  // and quietly never match any query's range.
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || !d.toISOString().startsWith(iso) ? null : iso;
}

/**
 * Strip a page path down to the thing we actually want to group by.
 *
 * Query strings are the reason this exists. The same article arrives as `/blogs/news/x`,
 * `/blogs/news/x?utm_source=instagram` and `/blogs/news/x?variant=123`, and left alone that is
 * three rows that each look like a third of the traffic. UTM parameters in particular mean the
 * best-promoted article fragments the most, which inverts the ranking it appears in.
 *
 * Trailing slashes are normalised for the same reason, except on the root, where the slash IS
 * the path.
 */
export function normalisePath(raw: string): string {
  let p = raw.trim();
  if (p === "") return "/";

  // GA4 usually gives a bare path, but a full URL turns up when a hostname filter is missing.
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      // Unparseable — fall through and treat it as an opaque path rather than dropping the row.
    }
  }

  p = p.split("?")[0].split("#")[0];
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

export type PageKind =
  /** An article or editorial feature — the thing this whole table exists to measure. */
  | "article"
  /** A product page. */
  | "product"
  /** A collection / category listing. */
  | "collection"
  /** The home page. */
  | "home"
  /** A static page (about, contact, terms). */
  | "page"
  /** Cart, checkout, account. Traffic here is mechanism, not readership. */
  | "funnel"
  /** Didn't match anything known. Surfaced rather than folded in — see below. */
  | "unclassified";

/**
 * Classify a path by shape.
 *
 * ## Why `unclassified` is a visible outcome and not a silent default
 *
 * These patterns are derived from the store's real converting URLs (standard Shopify:
 * `/products/…`, `/collections/…`, `/cart`, `/checkouts/…`, `/a/account/…`) plus Shopify's blog
 * convention. But esses.com is a separate editorial site from the Shopify store, and its
 * article paths are not visible in order data at all — no `/blogs/` path appears among
 * converting landing URLs, which is exactly why GA4 is being connected.
 *
 * So some of this is inference, and the honest response to inference is to make its failures
 * countable. Everything unmatched lands in `unclassified` and the page reports how much traffic
 * is sitting there. If that number is large, the patterns are wrong and the fix is to read the
 * actual paths rather than to trust a classifier that was quietly folding them into "other".
 */
export function classifyPath(path: string): PageKind {
  const p = path.toLowerCase();

  if (p === "/") return "home";

  // Funnel first. `/a/account/login` would otherwise be caught by nothing and read as content,
  // and checkout paths carry per-session tokens that would each look like a unique article.
  if (
    p === "/cart" ||
    p.startsWith("/cart/") ||
    p.startsWith("/checkouts/") ||
    p.startsWith("/checkout") ||
    p.startsWith("/a/account") ||
    p.startsWith("/account") ||
    p.startsWith("/apps/") ||
    p.startsWith("/tools/")
  ) {
    return "funnel";
  }

  if (p.startsWith("/products/")) return "product";
  if (p.startsWith("/collections/")) return "collection";

  // Shopify blogs are `/blogs/<blog>/<handle>`; the two-segment form is the blog index, which is
  // a listing rather than an article.
  if (p.startsWith("/blogs/")) {
    return p.split("/").filter(Boolean).length >= 3 ? "article" : "collection";
  }

  // Editorial paths seen on magazine sites. Listed explicitly so adding one is a visible change
  // rather than a regex nobody can read.
  for (const prefix of ["/features/", "/articles/", "/news/", "/stories/", "/read/", "/blog/"]) {
    if (p.startsWith(prefix)) {
      return p.split("/").filter(Boolean).length >= 2 ? "article" : "collection";
    }
  }

  if (p.startsWith("/pages/")) return "page";

  return "unclassified";
}

/** Pages whose traffic is readership rather than mechanism. */
export function isContentKind(kind: PageKind): boolean {
  return kind === "article" || kind === "page" || kind === "home";
}

export interface ShapeResult {
  rows: ShapedRow[];
  /** Sessions GA4 hid in the `(other)` bucket, per date. */
  otherByDate: Map<string, number>;
  /** Rows dropped because their date was unparseable. Should be zero; loud if not. */
  droppedRows: number;
}

/**
 * Collapse GA4 rows to one per (date, path), resolving titles and pulling out `(other)`.
 *
 * ## Why aggregation is needed at all
 *
 * Two GA4 rows can map to the same stored row, and both cases are ordinary rather than
 * pathological:
 *
 *  - `pageTitle` is a dimension, so an article retitled mid-window comes back as two rows for
 *    the same path and day.
 *  - `normalisePath` merges `?utm_source=…` variants that GA4 reports separately.
 *
 * The unique index is on (date, path), so without this an upsert batch containing both rows
 * would either conflict or — worse, depending on the batch shape — let the second silently
 * overwrite the first and report a fraction of the real traffic.
 *
 * Metrics sum. The title cannot, so the one from the highest-traffic row wins: the title a page
 * had while most people were reading it is the most useful single answer.
 */
export function shapeRows(raw: Ga4Row[], provisionalFrom: string | null): ShapeResult {
  const byKey = new Map<string, ShapedRow>();
  // Which row supplied the current title, kept alongside rather than on the row so the shaped
  // rows are exactly what gets stored — no field to remember to strip on the way out.
  const titleWeight = new Map<string, number>();
  const otherByDate = new Map<string, number>();
  let droppedRows = 0;

  for (const r of raw) {
    const date = parseGa4Date(r.date);
    if (!date) {
      droppedRows += 1;
      continue;
    }

    // The `(other)` bucket is not a page. Recorded per day as the size of the blind spot, and
    // deliberately never stored as a row — a row called "(other)" ranking third in a top-pages
    // table is worse than no row, because it reads as a page.
    if (r.pagePath === OTHER_ROW) {
      otherByDate.set(date, (otherByDate.get(date) ?? 0) + r.sessions);
      continue;
    }

    const pagePath = normalisePath(r.pagePath);
    const key = `${date} ${pagePath}`;
    const existing = byKey.get(key);

    // Provisional is a property of the DATE, compared against the processing window. Not of the
    // sync's recency: a row fetched today for three days ago is settled.
    const isProvisional = provisionalFrom !== null && date >= provisionalFrom;

    if (!existing) {
      byKey.set(key, {
        date,
        pagePath,
        pageTitle: r.pageTitle?.trim() || null,
        sessions: r.sessions,
        views: r.views,
        users: r.users,
        engagedSessions: r.engagedSessions,
        engagementSeconds: r.engagementSeconds,
        entrances: r.entrances,
        isProvisional,
      });
      titleWeight.set(key, r.views);
      continue;
    }

    existing.sessions += r.sessions;
    existing.views += r.views;
    // `users` is a de-duplicated count, so summing it across merged rows overstates. Kept as the
    // largest contributing row's value: an undercount we can explain beats an overcount we
    // cannot. See the note on the column.
    existing.users = Math.max(existing.users, r.users);
    existing.engagedSessions += r.engagedSessions;
    existing.engagementSeconds += r.engagementSeconds;
    existing.entrances += r.entrances;

    if (r.views > (titleWeight.get(key) ?? -1)) {
      existing.pageTitle = r.pageTitle?.trim() || existing.pageTitle;
      titleWeight.set(key, r.views);
    }
  }

  return { rows: [...byKey.values()], otherByDate, droppedRows };
}

/**
 * The first date GA4 may still revise, as `YYYY-MM-DD`, or null if the lag covers nothing.
 *
 * Takes `now` rather than reading the clock so it is testable and so a backfill can ask the
 * question as of a fixed moment.
 */
export function provisionalFrom(now: Date): string {
  const cutoff = new Date(now.getTime() - PROCESSING_LAG_HOURS * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

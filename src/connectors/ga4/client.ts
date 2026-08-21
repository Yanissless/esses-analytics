/**
 * The GA4 Data API, wrapped.
 *
 * One report shape, requested two ways: broken down by page, and again without the page
 * dimension for day totals. The second query is the point of the first being trustworthy — see
 * the note on `fetchDayTotals`.
 */

import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { OTHER_ROW, PAGE_SIZE, type Ga4Row } from "./shape";

/** Metrics requested, in the order the response returns them. */
const METRICS = [
  "sessions",
  "screenPageViews",
  "totalUsers",
  "engagedSessions",
  "userEngagementDuration",
  "entrances",
] as const;

export interface ReportMeta {
  /**
   * GA4 collapsed low-traffic paths into `(other)`.
   *
   * Comes from the response's own `dataLossFromOtherRow` flag AND from spotting the literal
   * row, because the flag has been observed absent on responses that plainly contain the
   * bucket. Either signal is enough — under-reporting a blind spot is the failure that matters.
   */
  hasOtherRow: boolean;
  /** GA4 answered from a sample rather than the full data set. */
  sampled: boolean;
  /** Rows GA4 says exist for the query, which is how pagination knows when to stop. */
  rowCount: number;
}

export interface PageReport {
  rows: Ga4Row[];
  meta: ReportMeta;
}

type AnalyticsClient = {
  runReport: (req: unknown) => Promise<[Ga4Response, ...unknown[]]>;
};

interface Ga4Response {
  rows?: Array<{
    dimensionValues?: Array<{ value?: string | null }>;
    metricValues?: Array<{ value?: string | null }>;
  }>;
  rowCount?: number | null;
  metadata?: {
    dataLossFromOtherRow?: boolean | null;
    samplingMetadatas?: Array<{ samplesReadCount?: unknown; samplingSpaceSize?: unknown }> | null;
  } | null;
}

let clientPromise: Promise<AnalyticsClient> | null = null;

/**
 * The Google client, created once.
 *
 * Memoised because constructing it reads and parses the key file and sets up a token exchange;
 * doing that per request would turn a paginated backfill into dozens of file reads. The promise
 * is cleared on rejection so a transient failure doesn't cache itself forever — the same
 * pattern as the Instagram account lookup.
 */
async function getClient(): Promise<AnalyticsClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { BetaAnalyticsDataClient } = await import("@google-analytics/data");
      return new BetaAnalyticsDataClient({
        keyFilename: env.GA4_CREDENTIALS_PATH,
      }) as unknown as AnalyticsClient;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Reset the memoised client. Used by tests and after a credentials change. */
export function resetGa4Client(): void {
  clientPromise = null;
}

const num = (v: string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function property(): string {
  return `properties/${env.GA4_PROPERTY_ID}`;
}

/**
 * Page-level rows for a date window, following pagination to the end.
 *
 * The window is passed as ISO dates and sent as one request per page rather than one per day.
 * GA4 bills a token quota per property per day, and asking 90 times for one day each costs
 * roughly 90 times as much as asking once for 90 days with `date` as a dimension.
 */
export async function fetchPageReport(
  startDate: string,
  endDate: string,
): Promise<PageReport> {
  const client = await getClient();
  const rows: Ga4Row[] = [];
  let hasOtherRow = false;
  let sampled = false;
  let rowCount = 0;
  let offset = 0;

  for (let page = 0; ; page += 1) {
    const [res] = await client.runReport({
      property: property(),
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "pagePath" }, { name: "pageTitle" }],
      metrics: METRICS.map((name) => ({ name })),
      limit: PAGE_SIZE,
      offset,
      // Ordering by date keeps pagination stable. Without a deterministic order, GA4 may return
      // a row on two pages or none, and a paginated read would silently double or drop it.
      orderBys: [{ dimension: { dimensionName: "date" } }],
      // Traffic on a page nobody visited is not a row worth a quota token.
      keepEmptyRows: false,
    });

    rowCount = num(String(res.rowCount ?? 0));
    if (res.metadata?.dataLossFromOtherRow) hasOtherRow = true;
    if ((res.metadata?.samplingMetadatas?.length ?? 0) > 0) sampled = true;

    const batch = res.rows ?? [];
    for (const r of batch) {
      const d = r.dimensionValues ?? [];
      const m = r.metricValues ?? [];
      const pagePath = d[1]?.value ?? "";
      if (pagePath === OTHER_ROW) hasOtherRow = true;

      rows.push({
        date: d[0]?.value ?? "",
        pagePath,
        pageTitle: d[2]?.value ?? undefined,
        sessions: num(m[0]?.value),
        views: num(m[1]?.value),
        users: num(m[2]?.value),
        engagedSessions: num(m[3]?.value),
        engagementSeconds: Math.round(num(m[4]?.value)),
        entrances: num(m[5]?.value),
      });
    }

    offset += batch.length;

    // Three independent stop conditions. A short page means the end; matching rowCount means
    // the end; an empty page means the end even if rowCount disagrees, which it can when a
    // report is still being processed. Any one of them alone has been enough to loop forever.
    if (batch.length === 0 || batch.length < PAGE_SIZE || offset >= rowCount) break;

    // Backstop. rowCount is GA4's own claim, and an infinite paginated loop against a metered
    // API is an expensive way to find out it was wrong.
    if (page >= 40) {
      logger.warn("GA4 pagination stopped at the page cap", { offset, rowCount });
      break;
    }
  }

  return { rows, meta: { hasOtherRow, sampled, rowCount } };
}

export interface DayTotal {
  date: string;
  sessions: number;
  views: number;
}

/**
 * Day totals with NO page dimension.
 *
 * This is the honest denominator, and it is a separate request on purpose. Summing the
 * page-level rows gives a different — smaller — number whenever GA4 has applied its `(other)`
 * bucket, and there is no way to detect the shortfall from inside the page-level data. Having
 * the real total means "the top ten articles are 40% of traffic" can be stated against
 * something, or withheld when it can't.
 *
 * Cheap: no high-cardinality dimension, so one request covers the whole window.
 */
export async function fetchDayTotals(
  startDate: string,
  endDate: string,
): Promise<DayTotal[]> {
  const client = await getClient();
  const [res] = await client.runReport({
    property: property(),
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }, { name: "screenPageViews" }],
    limit: 400,
    keepEmptyRows: false,
  });

  return (res.rows ?? []).map((r) => ({
    date: r.dimensionValues?.[0]?.value ?? "",
    sessions: num(r.metricValues?.[0]?.value),
    views: num(r.metricValues?.[1]?.value),
  }));
}

/** Cheap credentials-and-permission probe. One metric, one week, no dimensions. */
export async function ga4HealthCheck(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const client = await getClient();
    const [res] = await client.runReport({
      property: property(),
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      metrics: [{ name: "sessions" }],
    });
    const sessions = num(res.rows?.[0]?.metricValues?.[0]?.value);
    return {
      ok: true,
      detail: `${sessions.toLocaleString("en-US")} sessions in the last 7 days`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The specific-diagnosis logic lives in scripts/check-ga4.ts, which exists because Google
    // returns the same 403 for several different mistakes. Pointing there beats duplicating it.
    return { ok: false, detail: `${msg.split("\n")[0]} — run \`run.cmd check:ga4\`` };
  }
}

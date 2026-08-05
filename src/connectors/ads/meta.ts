/**
 * Meta (Facebook/Instagram) Marketing API connector.
 *
 * Pulls ad-level daily insights: spend, impressions, clicks, and Meta's own
 * reported purchases/value. Meta's numbers are stored as *platform-reported* and
 * never treated as our attribution — the reconciliation delta between Meta's
 * claims and our order-based attribution is itself a signal (Section 8.4).
 *
 * ⚠️ NOT YET VERIFIED AGAINST LIVE DATA — needs META_ACCESS_TOKEN and
 * META_AD_ACCOUNT_ID. The request shape follows the documented Insights API
 * (`/{ad_account}/insights` with `level=ad`, `time_increment=1`). Run
 * `healthCheck()` first once credentials exist: it confirms the account is
 * reachable and reports its currency and timezone before any sync writes rows.
 *
 * Two Meta-specific gotchas handled below:
 *  - Spend arrives as a decimal STRING in the account currency, not minor units.
 *  - Conversions live inside nested `actions` / `action_values` arrays keyed by
 *    action_type; we sum the purchase-type entries rather than trusting a
 *    top-level field (there isn't one).
 */
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import type { SyncWindow } from "../types";
import type { AdPlatformConnector, AdSpendRow } from "./types";

const API_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

/**
 * Meta purchase action types, MOST COMPLETE FIRST.
 *
 * These are overlapping VIEWS of the same conversions, not separate events:
 * `omni_purchase` is Meta's deduplicated cross-channel total (web + app +
 * offline), `purchase` is its usual alias, and
 * `offsite_conversion.fb_pixel_purchase` is the web/pixel subset that
 * `omni_purchase` already contains. So we take the FIRST type present and never
 * add them together.
 *
 * Summing them (what this did originally) inflated conversions about 3×: Meta
 * appeared to claim 8,116 purchases against 2,766 real paid orders, and on
 * 2026-04-28 claimed 208 on a day the store took 2 orders. A reconciliation built
 * on that measures our own arithmetic, not Meta's attribution.
 */
const PURCHASE_ACTION_PRIORITY = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "web_in_store_purchase",
] as const;

interface MetaAction {
  action_type?: string;
  value?: string | number;
}

interface MetaInsightRow {
  date_start?: string;
  date_stop?: string;
  account_id?: string;
  account_currency?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
}

interface MetaPage<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: { message?: string; type?: string; code?: number };
}

const toCents = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const toInt = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The purchase count (or value) from an actions/action_values array, taking the
 * single most complete action type present rather than summing overlapping ones.
 *
 * Meta can report the same action type more than once in one array when a
 * breakdown is in play, so entries OF THE CHOSEN TYPE are summed — but types are
 * never mixed.
 */
export function pickPurchaseAction(actions: MetaAction[] | undefined): number {
  if (!actions?.length) return 0;

  for (const wanted of PURCHASE_ACTION_PRIORITY) {
    let total = 0;
    let found = false;
    for (const a of actions) {
      if (a.action_type !== wanted) continue;
      const n = typeof a.value === "number" ? a.value : parseFloat(String(a.value ?? "0"));
      if (Number.isFinite(n)) {
        total += n;
        found = true;
      }
    }
    if (found) return total;
  }
  return 0;
}

/** Normalise an account id to the `act_<digits>` form Meta's endpoints expect. */
export function normalizeAccountId(raw: string): string {
  const t = raw.trim();
  return t.startsWith("act_") ? t : `act_${t.replace(/^act_/, "")}`;
}

/** Map one Meta insights row to our normalised shape. */
export function mapInsightRow(row: MetaInsightRow, fallbackAccountId: string): AdSpendRow {
  return {
    platform: "meta",
    date: row.date_start ?? "",
    accountId: row.account_id ? `act_${row.account_id.replace(/^act_/, "")}` : fallbackAccountId,
    campaignId: row.campaign_id ?? null,
    campaignName: row.campaign_name ?? null,
    adsetId: row.adset_id ?? null,
    adsetName: row.adset_name ?? null,
    adId: row.ad_id ?? null,
    adName: row.ad_name ?? null,
    currency: (row.account_currency ?? "USD").toUpperCase(),
    spendAmount: toCents(row.spend),
    impressions: toInt(row.impressions),
    clicks: toInt(row.clicks),
    platformConversions: pickPurchaseAction(row.actions),
    platformConversionValueAmount: Math.round(pickPurchaseAction(row.action_values) * 100),
  };
}

function token(): string {
  const t = env.META_ACCESS_TOKEN;
  if (!t) throw new Error("META_ACCESS_TOKEN is not set");
  return t;
}

function accountId(): string {
  const a = env.META_AD_ACCOUNT_ID;
  if (!a) throw new Error("META_AD_ACCOUNT_ID is not set");
  return normalizeAccountId(a);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gap between month chunks, to stay under Meta's per-account request scoring. */
const PACE_BETWEEN_CHUNKS_MS = 3000;
/** Gap between pagination pages within a chunk. */
const PACE_BETWEEN_PAGES_MS = 750;
const MAX_ATTEMPTS = 7;

async function metaGet<T>(url: string): Promise<MetaPage<T>> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url);
    const body = (await res.json()) as MetaPage<T>;

    if (res.ok && !body.error) return body;

    const code = body.error?.code;
    // 4/17/80004 = rate limiting, 1/2 = transient platform errors.
    const retryable = [1, 2, 4, 17, 341, 80000, 80004].includes(Number(code)) || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(
        `Meta API error (HTTP ${res.status}, code ${code ?? "?"}): ${body.error?.message ?? "unknown"}`,
      );
    }
    // Rate-limit recovery needs real patience — up to ~2 min on later attempts.
    const waitMs = Math.min(120_000, 2 ** attempt * 1000);
    logger.warn(`Meta API throttled/transient (code ${code}); retrying in ${waitMs}ms`, { attempt });
    await sleep(waitMs);
  }
  throw new Error("Meta API: retries exhausted");
}

const FIELDS = [
  "date_start",
  "account_id",
  "account_currency",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "spend",
  "impressions",
  "clicks",
  "actions",
  "action_values",
].join(",");

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export const metaConnector: AdPlatformConnector = {
  platform: "meta",
  label: "Meta Ads",

  isConfigured: () => Boolean(env.META_ACCESS_TOKEN && env.META_AD_ACCOUNT_ID),

  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, detail: "META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not set" };
    }
    try {
      const url =
        `${BASE}/${accountId()}?fields=name,currency,timezone_name,account_status` +
        `&access_token=${encodeURIComponent(token())}`;
      const res = await fetch(url);
      const body = (await res.json()) as {
        name?: string;
        currency?: string;
        timezone_name?: string;
        account_status?: number;
        error?: { message?: string };
      };
      if (!res.ok || body.error) {
        return { ok: false, detail: body.error?.message ?? `HTTP ${res.status}` };
      }
      return {
        ok: true,
        detail: `${body.name ?? accountId()} · ${body.currency ?? "?"} · ${body.timezone_name ?? "?"} · status ${body.account_status ?? "?"}`,
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },

  async fetchSpend(window: SyncWindow): Promise<AdSpendRow[]> {
    const acct = accountId();
    const start = window.since;
    const end = window.until ?? new Date();

    // Meta answers long ad-level daily ranges with "Service temporarily
    // unavailable" (error code 2) rather than a clear size error — a ~10-month
    // window at ~400 ad-days/week is tens of thousands of rows. Walking one month
    // at a time keeps each request comfortably inside its limits, and a failure
    // only costs one month rather than the whole backfill.
    const out: AdSpendRow[] = [];
    let totalPages = 0;
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

    while (cursor <= end) {
      const monthStart = cursor > start ? cursor : start;
      const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      const monthEndCandidate = new Date(nextMonth.getTime() - 24 * 3600 * 1000);
      const monthEnd = monthEndCandidate < end ? monthEndCandidate : end;

      if (monthStart <= monthEnd) {
        out.push(...(await fetchWindow(acct, iso(monthStart), iso(monthEnd), (n) => (totalPages += n))));
        // Pace between chunks. Each month succeeds on its own, but firing ~10 of
        // them back-to-back trips Meta's per-account rate limiting, which it
        // reports as the misleading "Service temporarily unavailable" (code 2).
        await sleep(PACE_BETWEEN_CHUNKS_MS);
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    logger.info("Meta insights fetched", {
      rows: out.length,
      pages: totalPages,
      since: iso(start),
      until: iso(end),
    });
    return out;
  },
};

/** Fetch one date window, following cursor pagination. */
async function fetchWindow(
  acct: string,
  since: string,
  until: string,
  countPages: (n: number) => void,
): Promise<AdSpendRow[]> {
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1", // one row per ad per day
    fields: FIELDS,
    time_range: JSON.stringify({ since, until }),
    limit: "500",
    access_token: token(),
  });

  let url = `${BASE}/${acct}/insights?${params.toString()}`;
  const out: AdSpendRow[] = [];
  let pages = 0;

  for (;;) {
    const page = await metaGet<MetaInsightRow>(url);
    for (const row of page.data ?? []) out.push(mapInsightRow(row, acct));

    pages++;
    const next = page.paging?.next;
    if (!next || (page.data?.length ?? 0) === 0) break;
    if (pages > 200) {
      logger.warn(`Meta pagination cap hit for ${since}..${until}`);
      break;
    }
    await sleep(PACE_BETWEEN_PAGES_MS);
    url = next;
  }

  countPages(pages);
  logger.debug(`Meta insights ${since}..${until}: ${out.length} rows, ${pages} page(s)`);
  return out;
}

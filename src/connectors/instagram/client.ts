/**
 * Instagram Graph API — follower counts and organic engagement.
 *
 * Unblocked 12 Aug 2026 when the four scopes were granted and a Page became visible. Until
 * then `/audience` ran on numbers pasted out of a CSV export.
 *
 * ## The shape of what Meta gives you, which drives everything here
 *
 * There are two different things and only one of them has history:
 *
 *  - **`followers_count`** is a field on the account object: the total, right now, exact.
 *    There is no dated version of it and no way to ask for last Tuesday's.
 *  - **`follower_count`** is an *insight*: new follows per day, over a rolling ~30-day
 *    window, and no further back.
 *
 * So a historical level series can only be built by walking the deltas back from a known
 * total — exactly what `import:social --meta-export` does by hand. The difference now is that
 * a nightly sync records one exact total per day, so the reconstructed portion is only ever
 * the initial 30-day backfill and the series becomes all-observed as it runs.
 *
 * That is also why this connector cannot repair the past: whatever was not recorded as it
 * happened is gone. Anything before the first sync stays reconstructed or hand-entered.
 *
 * Read-only by construction: every call below is a bare `fetch(url)` with no `method`, so
 * GET. The granted scopes carry no publish capability either — writing content needs
 * `instagram_content_publish` or `pages_manage_posts`, neither of which this token has.
 */

import { env } from "../../lib/env";
import { logger } from "../../lib/logger";

const API_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

function token(): string {
  const t = env.META_ACCESS_TOKEN;
  if (!t) throw new Error("META_ACCESS_TOKEN is not set");
  return t;
}

async function get<T>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}access_token=${encodeURIComponent(token())}`);
  const body = (await res.json()) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || body.error) {
    throw new Error(
      `Instagram Graph ${path.split("?")[0]}: ${body.error?.message ?? `HTTP ${res.status}`}` +
        (body.error?.code ? ` (code ${body.error.code})` : ""),
    );
  }
  return body;
}

export interface InstagramAccount {
  id: string;
  username: string | null;
  followersCount: number;
  followsCount: number | null;
  mediaCount: number | null;
  /** The Page it hangs off — Instagram permissions are reached through a Page. */
  pageName: string | null;
}

/**
 * Memoised for the life of the process.
 *
 * Discovery is two HTTP calls and every insight request needs the account ID first. A 30-day
 * backfill asks for five metrics a day, so without this it would spend 300 requests
 * re-answering "which account?" — enough to hit Meta's rate limit on a backfill and blame it
 * on the metrics. Held as the promise rather than the value so concurrent callers share one
 * in-flight lookup instead of racing to start their own.
 *
 * Scoped to one process, so a long-running server picks up a re-linked account on restart. The
 * account ID does not change during a sync.
 */
let accountPromise: Promise<InstagramAccount | null> | null = null;

/** Forces the next lookup to hit the API. For tests and for a re-link mid-process. */
export function resetInstagramAccountCache(): void {
  accountPromise = null;
}

/**
 * Finds the Instagram business account, by discovery rather than configuration.
 *
 * Deliberately no `INSTAGRAM_ACCOUNT_ID` env var: the ID is already reachable through
 * `/me/accounts`, and a hand-copied numeric ID in `.env` is one more thing that can be wrong
 * in a way nothing detects. Returns null when no Page has a linked account, which is a
 * legitimate state (one of the two Esses Pages has none) rather than an error.
 */
export async function getInstagramAccount(): Promise<InstagramAccount | null> {
  // A failed lookup is not cached — clearing on rejection means a transient network error
  // doesn't poison every later call in the process with the same failure.
  if (!accountPromise) {
    accountPromise = fetchInstagramAccount().catch((err) => {
      accountPromise = null;
      throw err;
    });
  }
  return accountPromise;
}

async function fetchInstagramAccount(): Promise<InstagramAccount | null> {
  const pages = await get<{
    data?: Array<{ name?: string; instagram_business_account?: { id?: string } }>;
  }>("/me/accounts?fields=name,instagram_business_account");

  const linked = (pages.data ?? []).find((p) => p.instagram_business_account?.id);
  if (!linked?.instagram_business_account?.id) return null;

  const id = linked.instagram_business_account.id;
  const acct = await get<{
    id: string;
    username?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
  }>(`/${id}?fields=username,followers_count,follows_count,media_count`);

  return {
    id: acct.id,
    username: acct.username ?? null,
    // The one exact, dated-as-of-now number Meta will give us.
    followersCount: Number(acct.followers_count ?? 0),
    followsCount: acct.follows_count == null ? null : Number(acct.follows_count),
    mediaCount: acct.media_count == null ? null : Number(acct.media_count),
    pageName: linked.name ?? null,
  };
}

export interface FollowerDelta {
  /** YYYY-MM-DD the follows occurred on. */
  date: string;
  /** Net new follows that day. */
  delta: number;
}

/** Meta refuses `follower_count` further back than 30 days. */
export const FOLLOWER_INSIGHT_MAX_DAYS = 30;

/**
 * Daily new-follow counts, as far back as Meta will go (30 days).
 *
 * Two Meta behaviours are easy to get wrong here and both fail quietly:
 *
 *  - **The window must be explicit.** With no `since`/`until`, insights default to the last
 *    *two days* — not the full 30. That silently produces a 2-day reconstruction which then
 *    gets spliced onto whatever older series already exists, and the join between two chains
 *    with different anchors shows up as a large one-day jump that never happened.
 *  - **`end_time` is the boundary AFTER the day described.** 2026-08-13T07:00:00+0000 describes
 *    12 August. Reading it as the day itself shifts the whole series one day later and silently
 *    decorrelates it from every other metric, so the date is taken as the day before.
 */
export async function getFollowerDeltas(): Promise<FollowerDelta[]> {
  const acct = await getInstagramAccount();
  if (!acct) return [];

  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - (FOLLOWER_INSIGHT_MAX_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const res = await get<{
    data?: Array<{ name?: string; values?: Array<{ value?: number; end_time?: string }> }>;
  }>(`/${acct.id}/insights?metric=follower_count&period=day&since=${since}&until=${until}`);

  const series = res.data?.find((d) => d.name === "follower_count")?.values ?? [];
  return series
    .filter((v) => v.end_time)
    .map((v) => {
      const endMs = Date.parse(v.end_time as string);
      // end_time is the boundary AFTER the day being described.
      const day = new Date(endMs - 86_400_000).toISOString().slice(0, 10);
      return { date: day, delta: Number(v.value ?? 0) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface AccountInsights {
  since: string;
  until: string;
  reach: number | null;
  /** Meta retired `impressions`; `views` is its replacement. */
  views: number | null;
  profileViews: number | null;
  accountsEngaged: number | null;
  totalInteractions: number | null;
  /**
   * Metrics that had to be summed from a daily series because Meta would not give a window
   * total. Those figures DOUBLE-COUNT repeat viewers and must be labelled, not quoted as
   * unique reach. Empty in the normal case.
   */
  summedMetrics: string[];
  /** Metrics Meta refused, with its reason. Reported rather than shown as zero. */
  unavailable: Array<{ metric: string; reason: string }>;
}

/** One day's organic figures. Nulls are "Meta didn't give us this", never zero. */
export interface DailyInsights {
  date: string;
  reach: number | null;
  views: number | null;
  profileViews: number | null;
  accountsEngaged: number | null;
  totalInteractions: number | null;
  unavailable: Array<{ metric: string; reason: string }>;
}

/**
 * One day's figures, for storing a daily series.
 *
 * Separate from `getAccountInsights` rather than derived from it, because a window total is
 * not the sum of its days. Reach de-duplicates accounts *across the whole window asked for*:
 * 28 days of reach is strictly less than 28 daily reach figures added up, since anyone who
 * saw you twice is counted once in the first and twice in the second. Deriving daily rows by
 * dividing a window total — or presenting summed daily reach as window reach — inflates it by
 * however loyal the audience is, which is exactly backwards.
 *
 * So each day is its own request. That costs one call per metric per day; the nightly run only
 * ever needs yesterday.
 *
 * The window is **half-open**: `since=day, until=day+1`. Meta returns periods whose boundary
 * falls inside the range, so `since === until` is a zero-length window and comes back empty
 * for every metric — not an error, just nothing, which is the failure mode most likely to be
 * read as "no activity that day" and stored as zeros.
 */
export async function getDailyInsights(day: string): Promise<DailyInsights> {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  // quiet: a 30-day backfill would otherwise log the same "metric unavailable" 30 times and
  // bury everything else. The caller reports it once, having seen all the days.
  const w = await getAccountInsights(day, next, { quiet: true });
  return {
    date: day,
    reach: w.reach,
    views: w.views,
    profileViews: w.profileViews,
    accountsEngaged: w.accountsEngaged,
    totalInteractions: w.totalInteractions,
    unavailable: w.unavailable,
  };
}

/**
 * Account-level organic performance for a window — the first of the gaps `/social` lists.
 *
 * Each metric is requested separately and a failure is recorded rather than thrown. Meta
 * deprecates and re-gates these individually, and one unavailable metric should not cost you
 * the ones that work. A missing metric surfaces as null with a reason attached — never as 0,
 * which would read as "nobody saw anything".
 *
 * Two Meta behaviours are handled rather than hard-coded around, because which bucket a metric
 * lives in has changed before and will change again:
 *
 *  - Some metrics are **time series** (`period=day`, one value per day, summed here).
 *  - Others are **total-value only** and reject `period=day` with an error naming
 *    `metric_type=total_value`. Rather than maintain a list, the day request is tried first and
 *    that specific error triggers one retry in the other shape. A hard-coded list would rot
 *    silently; the retry adapts.
 *
 * `impressions` was retired outright for accounts created after mid-2024 — `views` replaced it.
 */
export async function getAccountInsights(
  since: string,
  until: string,
  opts: { quiet?: boolean } = {},
): Promise<AccountInsights> {
  const acct = await getInstagramAccount();
  const unavailable: Array<{ metric: string; reason: string }> = [];
  if (!acct) {
    return {
      since,
      until,
      reach: null,
      views: null,
      profileViews: null,
      accountsEngaged: null,
      totalInteractions: null,
      summedMetrics: [],
      unavailable: [{ metric: "all", reason: "no linked Instagram business account" }],
    };
  }

  const window = `since=${since}&until=${until}`;
  const summed: string[] = [];

  /**
   * The de-duplicated figure for the whole window. **Tried first, and that matters.**
   *
   * `reach` accepts both shapes and they mean different things. `metric_type=total_value`
   * returns distinct accounts across the window; `period=day` returns a daily series whose sum
   * counts anyone who saw you on three days three times. An earlier version summed the series
   * and labelled the result "reach", which inflated a 28-day figure by the whole of repeat
   * viewership — invisible, because both numbers look like plausible reach.
   *
   * `period=day` stays on the request: total_value is an extra dimension on top of period, not
   * an alternative to it. Dropping it earns "The parameter period is required".
   */
  const asTotal = async (metric: string): Promise<number> => {
    const res = await get<{ data?: Array<{ total_value?: { value?: number } }> }>(
      `/${acct.id}/insights?metric=${metric}&period=day&metric_type=total_value&${window}`,
    );
    const total = res.data?.[0]?.total_value?.value;
    if (total == null) throw new Error("no total_value returned for this window");
    return Number(total);
  };

  /** Fallback: sum a `period=day` series. Recorded in `summedMetrics` when used. */
  const asSeries = async (metric: string): Promise<number> => {
    const res = await get<{ data?: Array<{ values?: Array<{ value?: number }> }> }>(
      `/${acct.id}/insights?metric=${metric}&period=day&${window}`,
    );
    const values = res.data?.[0]?.values ?? [];
    if (values.length === 0) throw new Error("no data returned for this window");
    summed.push(metric);
    return values.reduce((a, v) => a + Number(v.value ?? 0), 0);
  };

  const one = async (metric: string): Promise<number | null> => {
    try {
      return await asTotal(metric);
    } catch (totalErr) {
      try {
        return await asSeries(metric);
      } catch (seriesErr) {
        // Report whichever error is more informative — the series path is the fallback, so
        // its failure is usually the real one ("no data for this window").
        unavailable.push({
          metric,
          reason: seriesErr instanceof Error ? seriesErr.message : String(totalErr),
        });
        return null;
      }
    }
  };

  const [reach, views, profileViews, accountsEngaged, totalInteractions] = await Promise.all([
    one("reach"),
    one("views"),
    one("profile_views"),
    one("accounts_engaged"),
    one("total_interactions"),
  ]);

  if (unavailable.length > 0 && !opts.quiet) {
    logger.warn("some Instagram insight metrics unavailable", { unavailable });
  }
  return {
    since,
    until,
    reach,
    views,
    profileViews,
    accountsEngaged,
    totalInteractions,
    summedMetrics: summed,
    unavailable,
  };
}

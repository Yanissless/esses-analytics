import Link from "next/link";
import { requireCapability } from "@/lib/auth/current-user";
import { connectorConfigured } from "@/lib/env";
import { resolvePageRange } from "@/lib/date-range.server";
import {
  editorialShare,
  engagedShare,
  engagementPerSession,
  getCoverage,
  getDailyTraffic,
  getKindSplit,
  getTopPages,
  shareOfTraffic,
  unclassifiedShare,
} from "@/metrics/content";
import type { PageKind } from "@/connectors/ga4/shape";
import { Badge, Card, Caveat, InfoTip, Stat, formatNum } from "../_components/ui";
import { Nav } from "../_components/nav";
import { DateRangePicker } from "../_components/date-range-picker";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null) => (v == null ? "—" : formatNum(Math.round(v)));

/** Seconds as `2m 14s`. Raw seconds past a minute or two stop being readable. */
function duration(sec: number | null): string {
  if (sec == null) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const KIND_LABEL: Record<PageKind, string> = {
  article: "Articles",
  product: "Product pages",
  collection: "Listings",
  home: "Home",
  page: "Static pages",
  funnel: "Cart & account",
  unclassified: "Unrecognised",
};

/**
 * What to do when GA4 isn't connected yet.
 *
 * This is the state the page will be in until the credentials land, so it is the version most
 * likely to be read. It says what is missing, where the walkthrough is, and what the page will
 * show — rather than an empty table that looks like the site has no traffic.
 */
function NotConfigured() {
  return (
    <Card title="Google Analytics isn't connected yet">
      <div className="space-y-3 text-sm text-neutral-600 dark:text-neutral-400">
        <p>
          This page needs two values in <code className="text-xs">.env.local</code>:{" "}
          <code className="text-xs">GA4_PROPERTY_ID</code> (the 9–10 digit number from
          Analytics → Admin → Property details — <em>not</em> the <code className="text-xs">G-…</code>{" "}
          Measurement ID) and <code className="text-xs">GA4_CREDENTIALS_PATH</code>, an absolute
          path to the service-account JSON key.
        </p>
        <p>
          Keep the key file <strong>outside</strong> the project folder so it can never be
          committed. The full walkthrough is in{" "}
          <code className="text-xs">docs/ga4-setup.md</code>, and{" "}
          <code className="text-xs">run.cmd check:ga4</code> names the specific mistake if the
          connection fails — Google returns the same 403 for several different causes.
        </p>
        <p className="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800/50">
          <strong className="text-neutral-800 dark:text-neutral-200">What it will show:</strong>{" "}
          traffic that never converts. Every other number in this app starts from an order, so an
          article read by 8,000 people who bought nothing is currently invisible — and that is
          the branded-article question, since a sponsored feature is bought on readership rather
          than on sales it drove.
        </p>
      </div>
    </Card>
  );
}

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Marketing capability: readership is acquisition data, not cost or customer data.
  const user = await requireCapability("marketing");
  const sp = await searchParams;
  const { range, compareMode, bounds } = await resolvePageRange(sp);

  const configured = connectorConfigured.ga4();

  const [coverage, split, articles, commerce, daily] = configured
    ? await Promise.all([
        getCoverage(range),
        getKindSplit(range),
        getTopPages(range, { limit: 25, kinds: ["article", "page"] }),
        getTopPages(range, { limit: 10, kinds: ["product", "collection"] }),
        getDailyTraffic(range),
      ])
    : [null, null, null, null, null];

  const unknownShare = split ? unclassifiedShare(split) : null;
  const editorial = split ? editorialShare(split) : null;

  // Sessions GA4 counted for the range but never attributed to a page, so they appear in no
  // category above. The gap between the two queries, stated rather than left for the reader to
  // spot by subtracting two tiles.
  const unallocated = coverage
    ? Math.max(0, coverage.totalSessions - coverage.itemisedSessions)
    : 0;

  // The share the listed articles account for, withheld when GA4 hid part of the range.
  const articleSessions = (articles ?? []).reduce((a, r) => a + r.sessions, 0);
  const listedShare = coverage ? shareOfTraffic(articleSessions, coverage) : null;

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Content & readership</h1>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              Web traffic from Google Analytics — what gets read, including what never converts.
            </p>
          </div>
          {configured ? (
            <DateRangePicker
              preset={range.preset}
              compareMode={compareMode}
              since={range.since}
              until={range.until}
              anchor={bounds.anchor}
              dataStart={bounds.start}
              lagDays={bounds.lagDays}
              // No period comparison here yet. GA4's own coverage is independent of the order
              // data the range anchors to, so a "vs previous" figure could silently compare a
              // full window against a partly-unsynced one.
              comparisonUnavailable
            />
          ) : null}
        </div>

        {!configured ? (
          <NotConfigured />
        ) : (
          <>
            {coverage && coverage.daysWithData === 0 ? (
              <Card title="No traffic stored for this range">
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  GA4 is configured but nothing is stored between {range.since} and {range.until}.
                  Run <code className="text-xs">run.cmd sync --source=ga4</code> to load it. GA4
                  keeps event data for 14 months at most, so anything older than that is not
                  recoverable from the API.
                </p>
              </Card>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Sessions"
                value={num(coverage?.totalSessions ?? null)}
                hint={`${coverage?.daysWithData ?? 0} of ${coverage?.daysInRange ?? 0} days`}
                emphasis
              />
              <Stat label="Pageviews" value={num(coverage?.totalViews ?? null)} />
              {/* Both of these are shares of ITEMISED sessions, and the label says so. Where
                  GA4 applied its "(other)" bucket the itemised total is smaller than the real
                  one — a seeded case had 35% of traffic outside any category — so a tile reading
                  "editorial share" against an unnamed denominator would be the most quotable
                  number on the page and the least defensible. */}
              <Stat
                label="Editorial share"
                value={pct(editorial)}
                hint={
                  unallocated > 0
                    ? `of ${formatNum(coverage?.itemisedSessions ?? 0)} itemised sessions — ${formatNum(unallocated)} uncategorised`
                    : "of sessions: articles, static pages, home"
                }
              />
              <Stat
                label="Unrecognised paths"
                value={pct(unknownShare)}
                hint={
                  unknownShare !== null && unknownShare > 0.15
                    ? "high — the path patterns need correcting"
                    : "of itemised sessions, classifier found no match"
                }
              />
            </div>

            {coverage && coverage.daysWithOtherRow > 0 ? (
              <Caveat
                summary={`GA4 hid ${formatNum(coverage.hiddenSessions)} session(s) in an "(other)" bucket on ${coverage.daysWithOtherRow} day(s) — per-page shares are withheld for this range.`}
              >
                Past a cardinality limit GA4 stops itemising pages and returns a single
                &ldquo;(other)&rdquo; row. The per-page rows then do not sum to the day, so any
                &ldquo;top articles are X% of traffic&rdquo; figure computed from them is
                inflated by an unknown amount — always in the flattering direction. The day
                totals in the tiles above come from a separate query with no page dimension, so
                those remain correct; it is only the per-page <em>shares</em> that cannot be
                trusted. Narrowing the date range usually brings the page count back under the
                limit.
              </Caveat>
            ) : null}

            {coverage && coverage.sampledDays > 0 ? (
              <Caveat
                summary={`GA4 answered from a sample on ${coverage.sampledDays} day(s), so those figures are estimates.`}
              >
                Sampling happens on high-traffic properties or complex queries. The numbers are
                directionally right but not exact, and two reads of the same range can differ.
              </Caveat>
            ) : null}

            <Card
              title="Where traffic goes"
              info="Composition, not attribution. This says how traffic divides between editorial and commerce pages — a fact about traffic. It makes no claim that an article drove a sale: GA4 runs its own attribution model, ours is built from order data, the two will disagree, and there is no way to adjudicate between them from outside. Attribution stays in one place."
              action={
                unknownShare !== null && unknownShare > 0.15 ? (
                  <Badge>classifier needs work</Badge>
                ) : null
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                      <th className="pb-2 pr-4 font-medium">Kind</th>
                      <th className="pb-2 pr-4 text-right font-medium">Sessions</th>
                      <th className="pb-2 pr-4 text-right font-medium">Views</th>
                      <th className="pb-2 text-right font-medium">Pages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(split ?? []).map((s) => (
                      <tr
                        key={s.kind}
                        className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                      >
                        <td className="py-2 pr-4 font-medium">
                          {KIND_LABEL[s.kind]}
                          {s.kind === "unclassified" ? (
                            <InfoTip label="What unrecognised means" width="24rem">
                              Paths that matched none of the known patterns. The patterns come
                              from the store&rsquo;s real converting URLs plus Shopify&rsquo;s
                              blog convention, but esses.com is a separate editorial site whose
                              article paths never appear in order data — so part of the
                              classifier is inference. This bucket is deliberately visible so
                              that inference can be checked rather than trusted. If it is large,
                              the fix is to read the actual paths and correct the patterns in{" "}
                              <code>src/connectors/ga4/shape.ts</code>.
                            </InfoTip>
                          ) : null}
                          {s.kind === "funnel" ? (
                            <InfoTip label="Why cart and account are separated">
                              Traffic here is mechanism, not readership. Checkout paths also
                              carry a per-session token, so each one would otherwise look like a
                              unique page with a single reader.
                            </InfoTip>
                          ) : null}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatNum(s.sessions)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                          {formatNum(s.views)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                          {formatNum(s.pages)}
                        </td>
                      </tr>
                    ))}
                    {(split ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-4 text-sm text-neutral-500">
                          Nothing stored for this range.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card
              title="Most-read articles"
              subtitle={
                listedShare?.share != null
                  ? `These ${articles?.length ?? 0} account for ${pct(listedShare.share)} of range traffic.`
                  : listedShare?.reason
                    ? "Share of total traffic withheld — see the caveat above."
                    : undefined
              }
              info="Ranked by sessions. Engagement per session is the readership-quality signal that matters when selling a sponsored feature: 5,000 sessions that all bounced is not the same product as 5,000 that read to the end. Engagement time is a total divided by sessions, never an average of averages."
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                      <th className="pb-2 pr-4 font-medium">Page</th>
                      <th className="pb-2 pr-4 text-right font-medium">Sessions</th>
                      <th className="pb-2 pr-4 text-right font-medium">Views</th>
                      <th className="pb-2 pr-4 text-right font-medium">
                        Engaged
                        <InfoTip label="What engaged means" align="right">
                          GA4 counts a session as engaged if it lasted over 10 seconds, fired a
                          conversion, or included two or more pageviews.
                        </InfoTip>
                      </th>
                      <th className="pb-2 pr-4 text-right font-medium">Time / session</th>
                      <th className="pb-2 text-right font-medium">
                        Days
                        <InfoTip label="Why days matter" align="right">
                          Days in range with any traffic. Separates one viral day from steady
                          readership — two articles with the same session count are very
                          different propositions if one earned it in a day and the other over a
                          month.
                        </InfoTip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(articles ?? []).map((r) => (
                      <tr
                        key={r.pagePath}
                        className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                      >
                        <td className="max-w-md py-2 pr-4">
                          <div className="truncate font-medium" title={r.pageTitle ?? r.pagePath}>
                            {r.pageTitle ?? r.pagePath}
                          </div>
                          <div className="truncate text-xs text-neutral-500" title={r.pagePath}>
                            {r.pagePath}
                            {r.provisional ? (
                              <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                                provisional
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatNum(r.sessions)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                          {formatNum(r.views)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                          {pct(engagedShare(r))}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                          {duration(engagementPerSession(r))}
                        </td>
                        <td className="py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                          {r.activeDays}
                        </td>
                      </tr>
                    ))}
                    {(articles ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-4 text-sm text-neutral-500">
                          No article traffic stored for this range. If the site does have
                          editorial pages, check the &ldquo;Unrecognised&rdquo; row above — their
                          paths may not match the classifier&rsquo;s patterns.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card
              title="Most-visited commerce pages"
              info="Product and collection pages, for context against the editorial numbers. Sessions here are not conversions — this page never claims a visit became a sale."
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                      <th className="pb-2 pr-4 font-medium">Page</th>
                      <th className="pb-2 pr-4 text-right font-medium">Sessions</th>
                      <th className="pb-2 text-right font-medium">Entrances</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(commerce ?? []).map((r) => (
                      <tr
                        key={r.pagePath}
                        className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                      >
                        <td className="max-w-md truncate py-2 pr-4" title={r.pagePath}>
                          {r.pagePath}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatNum(r.sessions)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                          {formatNum(r.entrances)}
                        </td>
                      </tr>
                    ))}
                    {(commerce ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-4 text-sm text-neutral-500">
                          Nothing stored for this range.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card
              title="Coverage"
              info="What this range can and cannot support. Every caveat on this page is computed here rather than per card, so a claim and its caveat cannot drift apart."
            >
              <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <div className="text-xs uppercase tracking-wide text-neutral-500">Days stored</div>
                  <div className="tabular-nums">
                    {coverage?.daysWithData ?? 0} / {coverage?.daysInRange ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-neutral-500">
                    Itemised sessions
                  </div>
                  <div className="tabular-nums">{num(coverage?.itemisedSessions ?? null)}</div>
                  {coverage && coverage.itemisedSessions < coverage.totalSessions ? (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      {formatNum(coverage.totalSessions - coverage.itemisedSessions)} not itemised
                    </div>
                  ) : null}
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-neutral-500">
                    Provisional days
                  </div>
                  <div className="tabular-nums">{coverage?.provisionalDays ?? 0}</div>
                  <div className="text-xs text-neutral-500">
                    GA4 revises the last ~48h
                    <InfoTip label="Why recent days change">
                      GA4 keeps reprocessing recent days for up to 48 hours, the same shape as ad
                      platforms restating spend. A provisional row is a real number that is not
                      yet final — different from missing data, and worth saying differently. A
                      later sync re-reads those days and the flag clears.
                    </InfoTip>
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-neutral-500">Days sampled</div>
                  <div className="tabular-nums">{coverage?.sampledDays ?? 0}</div>
                </div>
              </div>
              {daily && daily.length > 0 ? (
                <p className="mt-4 text-xs text-neutral-500">
                  Stored {coverage?.firstDay} → {coverage?.lastDay}. Day totals come from a query
                  with no page dimension, which is why they can exceed the sum of the pages above.
                </p>
              ) : null}
            </Card>

            <p className="text-xs text-neutral-500">
              Content metrics only — no attribution. For where revenue came from, see{" "}
              <Link href="/marketing" className="underline decoration-dotted underline-offset-2">
                Marketing
              </Link>
              .
            </p>
          </>
        )}
      </main>
    </div>
  );
}

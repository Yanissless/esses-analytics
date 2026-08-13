import { requireCapability } from "@/lib/auth/current-user";
import { resolvePageRange } from "@/lib/date-range.server";
import {
  getCampaignPerformance,
  getCreativeCoverage,
  getCreativeMedia,
  isAcquisitionPlay,
  type CampaignRow,
  type CreativeRow,
} from "@/attribution/creatives";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { DateRangePicker } from "../_components/date-range-picker";
import { FreshnessBanner } from "../_components/freshness-banner";
import { getSourceFreshness } from "@/lib/freshness.server";
import { CreativeStrip, CreativeThumb } from "./thumbnail";

export const dynamic = "force-dynamic";

const x = (v: number | null, dp = 2) => (v == null ? "—" : `${v.toFixed(dp)}×`);
const pct = (v: number | null, dp = 1) => (v == null ? "—" : `${(v * 100).toFixed(dp)}%`);

/**
 * What we can prove each creative earned — and where ROAS is the wrong question.
 *
 * The measure column is deliberately not always ROAS. "Free Quarterly Campaign" spent $5,076,
 * drove 46 orders and collected $0 because the offer attached to it gives the issue away; on
 * a ROAS ranking it is the worst thing in the account, which is exactly backwards. Lines whose
 * attributed orders are overwhelmingly $0 are labelled as acquisition and shown cost-per-order
 * instead, so nobody switches off a working subscriber funnel for looking unprofitable.
 */
function MeasureCell({ row }: { row: CampaignRow | CreativeRow }) {
  if (isAcquisitionPlay(row)) {
    const cpo = row.ourOrders > 0 ? row.spendCents / row.ourOrders : null;
    return (
      <span className="whitespace-nowrap">
        <Badge tone="blue">acquisition</Badge>{" "}
        <span className="text-neutral-500 dark:text-neutral-400">
          {cpo == null ? "—" : `${formatUsd(cpo)}/order`}
        </span>
      </span>
    );
  }
  if (row.ourOrders === 0) {
    return <span className="text-neutral-400">no tagged orders</span>;
  }
  return (
    <span
      className={
        (row.ourRoas ?? 0) >= 1
          ? "font-medium text-emerald-600 dark:text-emerald-400"
          : "text-neutral-600 dark:text-neutral-400"
      }
    >
      {x(row.ourRoas)}
    </span>
  );
}

/**
 * Names the gap between Meta's conversion count and ours, per creative.
 *
 * Sam compared Ads Manager against this page: Meta credited "Artist Table - GYFIF - Copy"
 * with 11 website purchases while the page showed 0 orders. Both are correct and they are
 * not the same measurement:
 *
 *  - **Meta** counts a purchase when its pixel fires within its attribution window, including
 *    1-day view-through and cross-device. It needs no link tagging, because the pixel
 *    recognises the browser.
 *  - **Ours** counts an order whose converting click carried `utm_content=<ad id>`. Untagged
 *    links are invisible to it no matter how many sales they caused.
 *
 * So "0 orders" against a non-zero Meta figure means UNMEASURED here, not unsuccessful — and
 * with 1 of 51 creatives tagged, that is currently most of them. The label says which it is,
 * because a bare 0 next to Meta's 11 reads as a bug in the app.
 */
function CreativeGap({ row }: { row: CreativeRow }) {
  const meta = Math.round(row.metaConversions);
  if (meta === 0 && row.ourOrders === 0) return null;

  if (row.ourOrders === 0 && meta > 0) {
    return (
      <span
        className="text-amber-600 dark:text-amber-400"
        title="Meta's pixel saw conversions this creative's links never tagged. Not a discrepancy in the data — a gap in UTM tagging."
      >
        untagged — Meta sees {meta}, we can&apos;t trace {meta === 1 ? "it" : "them"}
      </span>
    );
  }
  if (meta > row.ourOrders) {
    return (
      <span
        className="text-neutral-400"
        title="Meta counts view-through and cross-device conversions we cannot observe."
      >
        +{meta - row.ourOrders} Meta-only
      </span>
    );
  }
  if (row.ourOrders > meta) {
    return (
      <span
        className="text-neutral-400"
        title="We traced more orders than Meta credited — usually a conversion falling outside Meta's attribution window."
      >
        +{row.ourOrders - meta} beyond Meta&apos;s window
      </span>
    );
  }
  return <span className="text-emerald-600 dark:text-emerald-400">agrees</span>;
}

function Offers({ row }: { row: CampaignRow | CreativeRow }) {
  if (row.discounts.length === 0) return <span className="text-neutral-400">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {row.discounts.slice(0, 4).map((d) => (
        <span
          key={d.code}
          title={`${d.orders} order(s), ${formatUsd(d.discountCents)} discounted`}
          className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        >
          {d.code} ×{d.orders}
        </span>
      ))}
      {row.discounts.length > 4 ? (
        <span className="text-[10px] text-neutral-400">+{row.discounts.length - 4}</span>
      ) : null}
    </span>
  );
}

export default async function CreativesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireCapability("marketing");
  const params = await searchParams;
  const { range, compareMode, comparison, bounds } = await resolvePageRange(params);

  const [campaigns, coverage, mediaById, freshness] = await Promise.all([
    getCampaignPerformance(range.since, range.until),
    getCreativeCoverage(range.since, range.until),
    getCreativeMedia(),
    getSourceFreshness(),
  ]);

  const taggedSpendShare =
    coverage.spendTotalCents > 0 ? coverage.spendTaggedCents / coverage.spendTotalCents : null;

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Campaigns &amp; creatives</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Spend against provable revenue, per campaign and per creative · {range.label}
          </p>
        </div>

        <DateRangePicker
          preset={range.preset}
          compareMode={compareMode}
          since={range.since}
          until={range.until}
          anchor={bounds.anchor}
          dataStart={bounds.start}
          lagDays={bounds.lagDays}
          comparisonUnavailable={comparison === null}
        />

        <FreshnessBanner freshness={freshness} sources={["meta", "shopify"]} />

        {/* Coverage leads, because a ranking over 11% of creatives presented as "what's
            working" is the confident-and-wrong artefact this app exists to avoid. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Spend in range"
            value={formatUsd(coverage.spendTotalCents, { compact: true })}
            hint={`${formatNum(coverage.campaignsTotal)} campaigns · ${formatNum(coverage.creativesTotal)} creatives`}
            emphasis
          />
          <Stat
            label="Spend we can trace"
            value={pct(taggedSpendShare)}
            hint={`${formatUsd(coverage.spendTaggedCents, { compact: true })} on campaigns with tagged traffic`}
            emphasis
          />
          <Stat
            label="Campaigns tagged"
            value={`${coverage.campaignsTagged} / ${coverage.campaignsTotal}`}
            hint="at least one converting click carried a UTM"
          />
          <Stat
            label="Creatives tagged"
            value={`${coverage.creativesTagged} / ${coverage.creativesTotal}`}
            hint="the rest are invisible to our attribution"
          />
        </div>

        <Card
          title="How this table is built, and what it cannot tell you"
          subtitle="Read this before switching a creative off."
        >
          <ul className="space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <li>
              <strong className="text-neutral-800 dark:text-neutral-200">
                Tagged clicks carry Meta&apos;s own IDs.
              </strong>{" "}
              <code className="font-mono">utm_campaign</code> holds the campaign ID and{" "}
              <code className="font-mono">utm_content</code> the ad ID, which join straight onto
              the spend rows — so no name matching is involved and a creative&apos;s spend and
              its provable revenue are genuinely the same creative.
            </li>
            <li>
              <strong className="text-neutral-800 dark:text-neutral-200">
                Untagged creatives look like they earned nothing.
              </strong>{" "}
              {coverage.creativesTotal - coverage.creativesTagged} of{" "}
              {coverage.creativesTotal} creatives have no tagged converting click, so they show
              &ldquo;no tagged orders&rdquo; — which means unmeasured, not unsuccessful. Only
              compare a creative against another creative that is also tagged.
            </li>
            <li>
              <strong className="text-neutral-800 dark:text-neutral-200">
                Revenue is assigned to one creative per order.
              </strong>{" "}
              The last tagged paid-meta touch before the order takes it. Splitting fractional
              revenue across creatives would make a per-creative ROAS that reconciles against
              nothing; counting it under every touch would inflate the column past real revenue.
            </li>
            <li>
              <strong className="text-neutral-800 dark:text-neutral-200">
                Meta&apos;s ROAS and ours are never blended.
              </strong>{" "}
              The gap between the columns is the useful part. Meta counts view-through and
              cross-device conversions we cannot observe; ours counts only what a session proves.
            </li>
            {coverage.unmatchedAdIds.length > 0 ? (
              <li>
                <strong className="text-neutral-800 dark:text-neutral-200">
                  {coverage.unmatchedAdIds.length} tagged ad ID(s) have no spend row in this
                  range.
                </strong>{" "}
                Traffic arrived from a creative whose spend sits outside the window (or whose ad
                was deleted), so its revenue appears under no line here. Listed rather than
                silently dropped.
              </li>
            ) : null}
          </ul>
        </Card>

        <Card
          title="Campaigns"
          subtitle="Ordered by spend — where the money went, whether or not it worked. Click a campaign for its creatives."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500 dark:text-neutral-400">
                <tr>
                  <th className="py-2 pr-3 font-medium">Campaign</th>
                  <th className="py-2 pr-3 text-right font-medium">Spend</th>
                  <th className="py-2 pr-3 text-right font-medium">CTR</th>
                  <th className="py-2 pr-3 text-right font-medium">Meta ROAS</th>
                  <th className="py-2 pr-3 text-right font-medium">Our orders</th>
                  <th className="py-2 pr-3 text-right font-medium">Our revenue</th>
                  <th className="py-2 pr-3 font-medium">Ours</th>
                  <th className="py-2 font-medium">Offers</th>
                </tr>
              </thead>
              <tbody className="text-neutral-700 dark:text-neutral-300">
                {campaigns.map((c) => (
                  <tr
                    key={c.campaignId ?? "none"}
                    className="border-t border-neutral-100 align-top dark:border-neutral-800"
                  >
                    <td className="py-2 pr-3">
                      {/* <details> rather than a client component: the drill-down needs no JS,
                          so it can't break on hydration and works with the page disabled. */}
                      <details>
                        <summary className="cursor-pointer font-medium marker:text-neutral-400">
                          {c.campaignName ?? "(unnamed campaign)"}{" "}
                          <span className="font-normal text-neutral-400">
                            {c.creatives.length} creative{c.creatives.length === 1 ? "" : "s"}
                          </span>
                          {!c.tagged ? (
                            <span className="ml-1 text-neutral-400">· untagged</span>
                          ) : null}
                        </summary>
                        {/* Previews sit above the list so the campaign is recognisable at a
                            glance — the whole point of asking "which creative is working". */}
                        <div className="mb-3 mt-2">
                          <CreativeStrip creatives={c.creatives} mediaById={mediaById} />
                        </div>
                        <div className="mt-2 space-y-2 border-l border-neutral-200 pl-3 dark:border-neutral-700">
                          {c.creatives.filter((cr) => cr.tagged || cr.spendCents > 0).slice(0, 25).map((cr) => (
                            <div
                              key={cr.adId ?? cr.adName ?? Math.random().toString()}
                              className="flex items-start gap-3"
                            >
                              <CreativeThumb
                                adId={cr.adId}
                                adName={cr.adName}
                                media={cr.adId ? mediaById.get(cr.adId) : undefined}
                                size={56}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                  <span className="font-medium">
                                    {cr.adName ?? cr.adId ?? "(unnamed)"}
                                  </span>
                                  <span className="text-neutral-500 dark:text-neutral-400">
                                    {formatUsd(cr.spendCents)} spend
                                  </span>
                                  <MeasureCell row={cr} />
                                  <Offers row={cr} />
                                </div>
                                {/* The two order counts side by side, always both shown.
                                    Sam compared Meta's per-ad purchases against this page and
                                    found ads Meta credits with 11 conversions showing "0
                                    orders" here. Both numbers are right; they answer different
                                    questions. Printing only ours made the page look broken. */}
                                <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
                                  <span className="text-neutral-500 dark:text-neutral-400">
                                    Meta{" "}
                                    <span className="font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
                                      {formatNum(Math.round(cr.metaConversions))}
                                    </span>{" "}
                                    purchase{Math.round(cr.metaConversions) === 1 ? "" : "s"}
                                  </span>
                                  <span className="text-neutral-500 dark:text-neutral-400">
                                    Ours{" "}
                                    <span className="font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
                                      {formatNum(cr.ourOrders)}
                                    </span>{" "}
                                    order{cr.ourOrders === 1 ? "" : "s"}
                                    {cr.ourFreeOrders > 0 ? ` (${cr.ourFreeOrders} free)` : ""} ·{" "}
                                    {formatUsd(cr.ourRevenueCents)}
                                  </span>
                                  <CreativeGap row={cr} />
                                </div>
                              </div>
                            </div>
                          ))}
                          {c.creatives.length > 25 ? (
                            <p className="text-[11px] text-neutral-400">
                              Showing the 25 highest-spend creatives of {c.creatives.length}.
                            </p>
                          ) : null}
                        </div>
                      </details>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatUsd(c.spendCents)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{pct(c.ctr, 2)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                      {x(c.metaRoas)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNum(c.ourOrders)}
                      {c.ourFreeOrders > 0 ? (
                        <span className="text-neutral-400"> ({c.ourFreeOrders} free)</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatUsd(c.ourRevenueCents)}
                    </td>
                    <td className="py-2 pr-3">
                      <MeasureCell row={c} />
                    </td>
                    <td className="py-2">
                      <Offers row={c} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </main>
    </div>
  );
}

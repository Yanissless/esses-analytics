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

/**
 * One metric in the campaign summary grid.
 *
 * Carries its own label, shown only below `lg`. The grid collapses to a single column on
 * narrow screens, where a right-aligned number whose heading lives in a hidden header row
 * would be unreadable — so the label travels with the value rather than living only in a
 * column head that may not be rendered.
 */
function Cell({
  label,
  value,
  strong = false,
  muted = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 lg:block lg:text-right">
      <span className="text-xs text-neutral-400 lg:hidden">{label}</span>
      <span
        className={`text-sm tabular-nums ${strong ? "font-medium" : ""} ${
          muted ? "text-neutral-400" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
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
      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
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

        {/* Campaigns are a stack of <details> cards, NOT a table.

            They were a table, and the drill-down lived inside the first <td> — so an expanded
            campaign's creatives could only ever use the width of the "Campaign" column, with
            two-thirds of the page sitting empty beside them. No amount of styling fixes that;
            a cell cannot be wider than its column. The header metrics keep their alignment via
            a grid on the summary row, and the body is free to use the whole width. */}
        <Card
          title="Campaigns"
          subtitle="Ordered by spend — where the money went, whether or not it worked. Click a campaign for its creatives."
        >
          {/* Column headings mirror the summary grid below. Hidden on small screens, where
              the summary stacks and labelled values carry the meaning instead. */}
          <div className="hidden grid-cols-[minmax(0,1fr)_7rem_5rem_6rem_7rem_8rem] gap-3 border-b border-neutral-200 px-2 pb-2 text-xs font-medium text-neutral-500 lg:grid dark:border-neutral-800 dark:text-neutral-400">
            <div>Campaign</div>
            <div className="text-right">Spend</div>
            <div className="text-right">CTR</div>
            <div className="text-right">Meta ROAS</div>
            <div className="text-right">Our orders</div>
            <div className="text-right">Our revenue</div>
          </div>

          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {campaigns.map((c) => (
              /* <details> rather than a client component: the drill-down needs no JS, so it
                 can't break on hydration and works with scripting disabled. */
              <details key={c.campaignId ?? "none"} className="group">
                <summary className="cursor-pointer list-none rounded-lg px-2 py-3 marker:content-none hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                  <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_7rem_5rem_6rem_7rem_8rem] lg:gap-3">
                    <div className="min-w-0">
                      <span className="mr-1.5 inline-block text-neutral-400 transition group-open:rotate-90">
                        ▸
                      </span>
                      <span className="text-sm font-medium">
                        {c.campaignName ?? "(unnamed campaign)"}
                      </span>
                      <span className="ml-2 text-xs text-neutral-400">
                        {c.creatives.length} creative{c.creatives.length === 1 ? "" : "s"}
                        {!c.tagged ? " · untagged" : ""}
                      </span>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-4">
                        <MeasureCell row={c} />
                        <Offers row={c} />
                      </div>
                    </div>
                    <Cell label="Spend" value={formatUsd(c.spendCents)} strong />
                    <Cell label="CTR" value={pct(c.ctr, 2)} />
                    <Cell label="Meta ROAS" value={x(c.metaRoas)} muted />
                    <Cell
                      label="Our orders"
                      value={`${formatNum(c.ourOrders)}${c.ourFreeOrders > 0 ? ` (${c.ourFreeOrders} free)` : ""}`}
                    />
                    <Cell label="Our revenue" value={formatUsd(c.ourRevenueCents)} />
                  </div>
                </summary>

                {/* Full page width from here — the whole reason the table had to go. */}
                <div className="px-2 pb-4 pt-1">
                  <CreativeStrip creatives={c.creatives} mediaById={mediaById} />

                  <div className="mt-4 space-y-1">
                    {c.creatives
                      .filter((cr) => cr.tagged || cr.spendCents > 0)
                      .slice(0, 25)
                      .map((cr) => (
                        <div
                          key={cr.adId ?? cr.adName ?? Math.random().toString()}
                          className="grid grid-cols-1 items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50 sm:grid-cols-[4.5rem_minmax(0,1fr)_7rem_9rem_9rem] dark:hover:bg-neutral-800/50"
                        >
                          <CreativeThumb
                            adId={cr.adId}
                            adName={cr.adName}
                            media={cr.adId ? mediaById.get(cr.adId) : undefined}
                            size={64}
                          />

                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {cr.adName ?? cr.adId ?? "(unnamed)"}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2">
                              <MeasureCell row={cr} />
                              <Offers row={cr} />
                            </div>
                          </div>

                          <div className="text-sm tabular-nums sm:text-right">
                            <span className="text-neutral-400 sm:hidden">Spend </span>
                            {formatUsd(cr.spendCents)}
                          </div>

                          {/* Meta's count and ours, side by side and always both shown. Sam
                              found ads Meta credits with 11 conversions showing "0 orders"
                              here; printing only ours made a correct page look broken. */}
                          <div className="text-sm sm:text-right">
                            <div className="tabular-nums text-neutral-600 dark:text-neutral-400">
                              Meta{" "}
                              <span className="font-medium text-neutral-800 dark:text-neutral-200">
                                {formatNum(Math.round(cr.metaConversions))}
                              </span>
                            </div>
                            <div className="tabular-nums text-neutral-600 dark:text-neutral-400">
                              Ours{" "}
                              <span className="font-medium text-neutral-800 dark:text-neutral-200">
                                {formatNum(cr.ourOrders)}
                              </span>
                              {cr.ourFreeOrders > 0 ? (
                                <span className="text-neutral-400"> ({cr.ourFreeOrders} free)</span>
                              ) : null}
                            </div>
                          </div>

                          <div className="text-sm sm:text-right">
                            <div className="tabular-nums">{formatUsd(cr.ourRevenueCents)}</div>
                            <div className="mt-0.5 text-xs">
                              <CreativeGap row={cr} />
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>

                  {c.creatives.length > 25 ? (
                    <p className="mt-2 px-2 text-xs text-neutral-400">
                      Showing the 25 highest-spend creatives of {c.creatives.length}.
                    </p>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </Card>
      </main>
    </div>
  );
}

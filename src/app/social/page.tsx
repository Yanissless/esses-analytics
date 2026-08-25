import { requireCapability } from "@/lib/auth/current-user";
import { getChurnCohorts } from "@/metrics/churn";
import {
  getPaidCampaignPerformance,
  getSocialLandingPages,
  getSocialPlatformPerformance,
  getSocialSummary,
  getTaggedCampaigns,
  SOCIAL_PLATFORM_METRICS_GAP,
} from "@/metrics/social";
import { getSocialInsights, type SocialInsightsSummary } from "@/metrics/social-insights";
import { Badge, Card, Caveat, Stat, formatNum, formatUsd } from "../_components/ui";
import { resolvePageRange } from "@/lib/date-range.server";
import { Nav } from "../_components/nav";
import { RefreshButton } from "../_components/refresh-button";
import { DateRangePicker } from "../_components/date-range-picker";
import { FreshnessBanner } from "../_components/freshness-banner";
import { getSourceFreshness } from "@/lib/freshness.server";
import { ReachSparkline } from "./reach-chart";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const x = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}×`);
const money = (v: number | null) => (v == null ? "—" : formatUsd(v));
const num = (v: number | null) => (v == null ? "—" : formatNum(Math.round(v)));

/**
 * Organic Instagram reach and engagement.
 *
 * The headline is **average daily reach**, not a range total, and that is a deliberate choice
 * rather than a limitation. Reach counts distinct accounts, so a 28-day total is not the sum of
 * 28 daily figures — for this account the sum overstates the truth by roughly half. A tile
 * labelled "reach" showing a summed figure would be wrong in a way nobody could see, so the sum
 * appears only where it is named as an upper bound.
 */
function InsightsPanel({ insights: i }: { insights: SocialInsightsSummary }) {
  if (i.daysWithData === 0) {
    return (
      <Card
        title="Instagram reach and engagement"
        subtitle="No stored figures for this range."
      >
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Nothing recorded between {i.since} and {i.until}. Meta serves these over a rolling
          window, so use{" "}
          <span className="inline-block align-middle">
            <RefreshButton label="Update now" />
          </span>{" "}
          to
          fill what it still has — anything older than that is gone for good.
        </p>
      </Card>
    );
  }

  const coverage =
    i.daysWithData < i.daysInRange
      ? `${i.daysWithData} of ${i.daysInRange} days have data`
      : `all ${i.daysInRange} days`;

  return (
    <Card
      title="Instagram reach and engagement"
      subtitle={`Account-level organic performance · ${coverage}`}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Reach / day"
          value={num(i.reachDailyAvg)}
          hint="distinct accounts, averaged over days with data"
          emphasis
        />
        <Stat
          label="Best day"
          value={i.reachPeak ? formatNum(i.reachPeak.reach) : "—"}
          hint={i.reachPeak ? i.reachPeak.date : "—"}
        />
        <Stat
          label="Engaged / reached"
          value={pct(i.engagementRatePerReach)}
          hint="accounts that interacted ÷ accounts reached"
        />
        <Stat
          label="Profile visits / reached"
          value={pct(i.profileViewRatePerReach)}
          hint={`${num(i.profileViews)} visits — closest thing to a click-through`}
        />
      </div>

      <div className="mt-4">
        <ReachSparkline points={i.points} />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Views"
          value={num(i.views)}
          hint={`${i.viewsPerReachedAccount?.toFixed(1) ?? "—"} per account reached`}
        />
        <Stat label="Interactions" value={num(i.totalInteractions)} hint="likes, comments, shares, saves" />
        <Stat
          label="Reach, summed"
          value={num(i.summedReachUpperBound)}
          hint="upper bound only — see the note below"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Caveat summary="Reach cannot be summed">
          Reach counts distinct accounts, so someone who saw you on ten days is one account, not
          ten. The &ldquo;reach, summed&rdquo; figure is what you get by adding the daily rows —
          an upper bound you would only hit if no account ever saw you twice, and for this account
          it runs roughly 50% above the truth. A genuine de-duplicated total has to be asked of
          Meta for that exact window, because de-duplicating needs the account identities, which
          aren&rsquo;t stored. <strong>Quote the per-day average.</strong>
        </Caveat>

        <Caveat summary="Rates are against accounts reached, not followers">
          Reach here runs well above the follower count because most of it is non-followers
          through Reels, so a rate against followers would exceed 100% and mean nothing.
        </Caveat>
      </div>
    </Card>
  );
}

export default async function SocialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireCapability("marketing");
  // Range from the URL, anchored to the last day with DATA — see lib/date-range.ts.
  const { range, compareMode, comparison, bounds } = await resolvePageRange(await searchParams);
  const since = range.since;
  const until = range.until;

  const [social, platforms, campaigns, landings, tagged, channelChurn, insights, freshness] =
    await Promise.all([
      getSocialSummary(since, until),
      getSocialPlatformPerformance(since, until),
      getPaidCampaignPerformance(since, until),
      getSocialLandingPages(since, until, 12),
      getTaggedCampaigns(since, until, 15),
      getChurnCohorts("channel", { minSubscriptions: 5 }),
      getSocialInsights("instagram", since, until),
      getSourceFreshness(),
    ]);

  const socialChurn = channelChurn.filter((c) =>
    ["organic-social", "paid-meta", "social-unknown", "paid-tiktok"].includes(c.key),
  );
  const unmatchedSpend = campaigns
    .filter((c) => c.unmatched)
    .reduce((s, c) => s + c.spendCents, 0);
  const maxSpend = Math.max(...campaigns.map((c) => c.spendCents), 1);
  const namedTagged = tagged.filter((t) => !t.looksLikeMetaId).length;
  const idTagged = tagged.filter((t) => t.looksLikeMetaId).length;

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Social</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Social traffic followed through to revenue, retention and margin — paid and organic on
            the same commerce outcome · {range.label}
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

        <FreshnessBanner freshness={freshness} sources={["meta", "instagram", "shopify"]} />

        {/* Was a full-width blue banner of five lines of prose. The scope note still matters —
            a reader who thinks this page covers per-post performance will conclude the data is
            missing rather than out of scope — but it does not need to shout. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Caveat summary="Commerce half of social, plus account-level engagement">
            Everything below the reach panel comes from visits that reached the store, so it
            answers which platform, campaign and landing page produced revenue and subscribers who
            stayed. Instagram reach and engagement arrived 13 Aug 2026.
          </Caveat>

          <Caveat summary={`Not covered: ${SOCIAL_PLATFORM_METRICS_GAP.map((g) => g.toLowerCase()).join(", ")}`}>
            Per-post figures need a media-by-media crawl — a different shape of connector,
            paginated over content rather than dates, whose cost grows with how much you publish.
            Tools like Later or Sprout cover that well; none of them can do the commerce half.
          </Caveat>
        </div>

        {/* Organic reach — the half of social that was a documented gap until the connector. */}
        <InsightsPanel insights={insights} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Social-touched revenue"
            value={formatUsd(social.socialRevenueCents)}
            hint={`${pct(social.shareOfRevenue)} of all revenue · ${formatNum(social.socialOrders)} orders`}
            emphasis
          />
          <Stat
            label="Social ad spend"
            value={formatUsd(social.paidSpendCents)}
            hint={`${formatNum(social.paidOrders)} paid-touched orders`}
          />
          <Stat
            label="Organic-only orders"
            value={formatNum(social.organicOrders)}
            hint="social orders with no paid touch at all"
          />
          <Stat
            label="Attribution coverage"
            value={pct(social.attributionCoverage)}
            hint="everything here is a floor, not a total"
          />
        </div>

        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>Organic social carries this channel, and it is the weakest cohort we have.</strong>{" "}
          {formatNum(social.organicOrders)} of {formatNum(social.socialOrders)} social orders had no
          paid touch. But grouped by retention, organic-social subscribers churn hardest and are
          worth least — see the retention panel below. Volume and quality are pointing in opposite
          directions here, which is the most useful thing on this page.
        </div>

        {/* ---- platforms ---- */}
        <Card
          title="By platform"
          subtitle="Identified from the referrer host, falling back to Shopify's own source — this works today without any UTM tagging"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Platform</th>
                  <th className="pb-2 text-right font-medium">Touchpoints</th>
                  <th className="pb-2 text-right font-medium">Paid / organic</th>
                  <th className="pb-2 text-right font-medium">Orders</th>
                  <th className="pb-2 text-right font-medium">Paid orders</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                  <th className="pb-2 text-right font-medium">AOV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {platforms.map((p) => (
                  <tr key={p.platform}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium capitalize">{p.platform}</span>
                        {p.platform === "unattributed platform" ? (
                          <Badge tone="amber">no referrer</Badge>
                        ) : null}
                      </div>
                      <div className="text-xs text-neutral-500">
                        {formatNum(p.customers)} customers
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatNum(p.touchpoints)}</td>
                    <td className="py-2 text-right text-xs tabular-nums text-neutral-500">
                      {formatNum(p.paidTouchpoints)} / {formatNum(p.organicTouchpoints)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatNum(p.orders)}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(p.paidOrders)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(p.revenueCents)}</td>
                    <td className="py-2 text-right tabular-nums">{money(p.aovCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            Revenue is counted per order the platform <em>touched</em>, not apportioned by an
            attribution model — an order touched by both Instagram and the newsletter appears at full
            value under Instagram. So this shows which platforms were involved in revenue;{" "}
            <strong>the column does not sum to total revenue.</strong> Use Marketing for the
            model-apportioned split. AOV divides by <strong>paid</strong> orders only, because 65% of
            this store&rsquo;s orders are $0 prepaid deliveries.
            {social.unidentifiedTouchpoints > 0 ? (
              <>
                {" "}
                {formatNum(social.unidentifiedTouchpoints)} touchpoints carry no referrer or usable
                source — mostly Meta&rsquo;s in-app browser, which sends none.
              </>
            ) : null}
          </p>
        </Card>

        {/* ---- retention by social channel: the ads↔churn tie-in ---- */}
        {socialChurn.length > 0 ? (
          <Card
            title="Do social subscribers stay?"
            subtitle="The question a social dashboard normally can't answer — churn measured at the first renewal, so cohorts of different ages are comparable"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                    <th className="pb-2 font-medium">Channel</th>
                    <th className="pb-2 text-right font-medium">Subscriptions</th>
                    <th className="pb-2 text-right font-medium">Churn by 1st renewal</th>
                    <th className="pb-2 text-right font-medium">Mature</th>
                    <th className="pb-2 text-right font-medium">Median life</th>
                    <th className="pb-2 text-right font-medium">LTV / sub</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {socialChurn.map((c) => (
                    <tr key={c.key}>
                      <td className="py-2 font-medium">{c.label}</td>
                      <td className="py-2 text-right tabular-nums">{formatNum(c.subscriptions)}</td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          (c.churnByFirstRenewalPct ?? 0) > 0.4
                            ? "text-red-600 dark:text-red-400"
                            : ""
                        }`}
                      >
                        {pct(c.churnByFirstRenewalPct)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-neutral-500">
                        {formatNum(c.matureSubscriptions)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {c.medianLifetimeMonths == null
                          ? "—"
                          : `${c.medianLifetimeMonths.toFixed(1)}mo`}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {money(c.ltvPerSubscriberCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              Full cohort analysis, including by issue and promo code, is on{" "}
              <strong>Churn &amp; cohorts</strong>.
            </p>
          </Card>
        ) : null}

        {/* ---- paid campaigns: the ads ↔ commerce join ---- */}
        <Card
          title="Paid campaigns"
          subtitle="Meta spend joined to the orders its tagged visits reached. Delivery metrics are exact; attributed revenue is a floor."
        >
          {unmatchedSpend > 0 ? (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <strong>{formatUsd(unmatchedSpend)} of spend has no identifiable visit.</strong> Those
              campaigns are marked <em>unmatched</em> below: Meta only tags some traffic, so we
              cannot connect their clicks to an order. That is a measurement gap, not proof the
              campaign sold nothing — several are awareness buys with sub-0.2% CTR and very low CPM,
              which is what an impressions campaign looks like. The UTM rollout closes this.
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Campaign</th>
                  <th className="pb-2 text-right font-medium">Spend</th>
                  <th className="pb-2 text-right font-medium">CTR</th>
                  <th className="pb-2 text-right font-medium">CPC</th>
                  <th className="pb-2 text-right font-medium">CPM</th>
                  <th className="pb-2 text-right font-medium">Orders</th>
                  <th className="pb-2 text-right font-medium">of which paid</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                  <th className="pb-2 text-right font-medium">ROAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {campaigns.map((c) => (
                  <tr key={c.campaignName}>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.campaignName}</span>
                        {c.unmatched ? <Badge tone="amber">unmatched</Badge> : null}
                        {!c.unmatched && c.attributedPaidOrders === 0 ? (
                          <Badge tone="neutral">free signups only</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 h-1 w-28 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                        <div
                          className="h-full bg-neutral-400 dark:bg-neutral-500"
                          style={{ width: `${(c.spendCents / maxSpend) * 100}%` }}
                        />
                      </div>
                      <div className="text-xs text-neutral-500">
                        {c.firstDay} → {c.lastDay}
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(c.spendCents)}</td>
                    <td className="py-2 text-right tabular-nums">{pct(c.ctr)}</td>
                    <td className="py-2 text-right tabular-nums">{money(c.cpcCents)}</td>
                    <td className="py-2 text-right tabular-nums">{money(c.cpmCents)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatNum(c.attributedOrders)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-neutral-500">
                      {formatNum(c.attributedPaidOrders)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsd(c.attributedRevenueCents)}
                    </td>
                    <td
                      className={`py-2 text-right font-medium tabular-nums ${
                        c.unmatched
                          ? "text-neutral-400"
                          : (c.roas ?? 0) >= 1
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {c.unmatched ? "—" : x(c.roas)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            <strong>Orders vs of-which-paid is the column pair to read.</strong> A campaign can drive
            plenty of orders at almost no revenue because it was buying free or heavily discounted
            signups — and whether that was a good trade depends on whether those subscribers renew,
            which is the retention panel above, not this table.
          </p>
        </Card>

        {/* ---- landing pages ---- */}
        <Card
          title="Where social traffic lands"
          subtitle="The closest available proxy for 'which post worked' until utm_content is in use"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Landing page</th>
                  <th className="pb-2 text-right font-medium">Touchpoints</th>
                  <th className="pb-2 text-right font-medium">Orders</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                  <th className="pb-2 text-right font-medium">Reached an order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {landings.map((l) => (
                  <tr key={l.path}>
                    <td className="py-2 font-mono text-xs">{l.path}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(l.touchpoints)}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(l.orders)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(l.revenueCents)}</td>
                    <td className="py-2 text-right tabular-nums">{pct(l.conversionRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            Checkout, cart and account paths are excluded — they&rsquo;re steps a visitor reaches
            after arriving, and each checkout URL is unique per session, so they flooded the list
            with meaningless single-order rows.
          </p>
        </Card>

        {/* ---- campaign tagging health ---- */}
        <Card
          title="Campaign tagging health"
          subtitle="What campaign names are actually reaching us — the readiness check for the UTM rollout"
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Readable campaign names"
              value={formatNum(namedTagged)}
              hint="usable in reporting as-is"
            />
            <Stat
              label="Opaque Meta IDs"
              value={formatNum(idTagged)}
              hint="numeric campaign ids, not names"
            />
            <Stat
              label="Social touchpoints"
              value={formatNum(social.socialTouchpoints)}
              hint={`${social.platformsIdentified} platforms identified`}
            />
          </div>
          {idTagged > 0 ? (
            <div className="mb-4 rounded-lg bg-neutral-100/70 p-3 text-xs text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
              <strong>
                Meta is already auto-tagging, but it sends campaign IDs rather than names.
              </strong>{" "}
              That&rsquo;s why {idTagged} rows below read as long numbers — they&rsquo;re real
              campaigns we simply can&rsquo;t name without cross-referencing. Setting{" "}
              <code className="font-mono">utm_campaign=&#123;&#123;campaign.name&#125;&#125;</code> in
              the Ads Manager URL-parameters field (step 6 of the tagging guide) fixes this for all
              future traffic, and is the single highest-value line in that document.
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Campaign tag</th>
                  <th className="pb-2 font-medium">Channels</th>
                  <th className="pb-2 text-right font-medium">Touchpoints</th>
                  <th className="pb-2 text-right font-medium">Orders</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {tagged.map((t) => (
                  <tr key={t.campaign}>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={t.looksLikeMetaId ? "font-mono text-xs" : "font-medium"}
                        >
                          {t.campaign}
                        </span>
                        {t.looksLikeMetaId ? <Badge tone="amber">meta id</Badge> : null}
                      </div>
                    </td>
                    <td className="py-2 text-xs text-neutral-500">{t.channels.join(", ")}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(t.touchpoints)}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(t.orders)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(t.revenueCents)}</td>
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

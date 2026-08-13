import Link from "next/link";
import { requireCapability } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/capabilities";
import { getPeriodMetrics } from "@/metrics/rollup";
import { breakevenMer, ratio } from "@/metrics/formulas";
import type { AttributionModel } from "@/attribution/models";
import {
  getAttributionCoverage,
  getChannelPerformance,
  type AttributionBasis,
} from "@/attribution/report";
import {
  getPlatformReconciliation,
  getPlatformTrend,
} from "@/attribution/reconciliation";
import { delta } from "@/lib/date-range";
import { resolvePageRange } from "@/lib/date-range.server";
import { Badge, Card, DeltaBadge, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { DateRangePicker } from "../_components/date-range-picker";
import { FreshnessBanner } from "../_components/freshness-banner";
import { getSourceFreshness } from "@/lib/freshness.server";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const x = (v: number | null, dp = 2) => (v == null ? "—" : `${v.toFixed(dp)}×`);
const money = (v: number | null) => (v == null ? "—" : formatUsd(v));

const MODELS: Array<{ id: AttributionModel; label: string; blurb: string }> = [
  { id: "last-non-direct", label: "Last non-direct", blurb: "credits the last touch that wasn't direct or internal" },
  { id: "first-touch", label: "First touch", blurb: "credits whichever channel found the customer" },
  { id: "linear", label: "Linear", blurb: "splits credit evenly across the path" },
  { id: "time-decay", label: "Time decay", blurb: "weights touches nearer the sale, 7-day half-life" },
];

const BASES: Array<{ id: AttributionBasis; label: string }> = [
  { id: "session-only", label: "Session only" },
  { id: "inherit-from-customer", label: "Inherit from customer" },
];

function isModel(v: string | undefined): v is AttributionModel {
  return MODELS.some((m) => m.id === v);
}
function isBasis(v: string | undefined): v is AttributionBasis {
  return BASES.some((b) => b.id === v);
}

/** Paid channels get spend attached; owned/organic ones never should. */
const isPaid = (channel: string) => channel.startsWith("paid-");

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireCapability("marketing");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const rawModel = one(params.model);
  const rawBasis = one(params.basis);
  const model: AttributionModel = isModel(rawModel) ? rawModel : "last-non-direct";
  const basis: AttributionBasis = isBasis(rawBasis) ? rawBasis : "session-only";

  // The marketing role reaches this page but must not see cost/margin figures.
  const showMargin = can(user.role, "margin");

  // Range comes from the URL and is anchored to the last day with DATA, not today — see
  // lib/date-range.ts for why that distinction is load-bearing.
  const { range, comparison, compareMode, bounds } = await resolvePageRange(params);
  const since = range.since;
  const until = range.until;

  const [period, channels, coverage, reconciliation, trend, freshness] = await Promise.all([
    getPeriodMetrics(since, until),
    getChannelPerformance(since, until, model, 7, basis),
    getAttributionCoverage(since, until),
    getPlatformReconciliation(since, until, model, basis),
    getPlatformTrend(since, until, "meta"),
    getSourceFreshness(),
  ]);

  // Only the blended headline is compared. Fetching a second copy of the channel tables and
  // the reconciliation would double the query load for a row of arrows nobody asked for,
  // and a per-channel delta over a short window is mostly attribution noise.
  const priorPeriod = comparison ? await getPeriodMetrics(comparison.since, comparison.until) : null;
  const d = (cur: number | null, prev: number | null) =>
    priorPeriod && cur != null && prev != null ? delta(cur, prev) : null;

  /*
   * Breakeven MER has to use the SAME revenue base as MER itself, or the
   * comparison is nonsense. MER's numerator is `period.revenueCents` — paid
   * Shopify orders ex-VAT plus Stripe — so the margin comes from the matching
   * `period.cm2Cents`, not from the Profit page's waterfall.
   *
   * The waterfall deliberately uses a wider boundary (everything except comps),
   * which charges prepaid-delivery fulfilment against zero in-period revenue and
   * currently yields a NEGATIVE CM2. Feeding that in produced "breakeven MER —"
   * beside a 5.15× MER, implying advertising could never pay for itself. That's an
   * artefact of the revenue-recognition boundary, not a marketing fact — see the
   * open question about recognising subscription revenue ratably.
   */
  const cmPct = ratio(period.cm2Cents, period.revenueCents);
  const breakeven = breakevenMer(cmPct);
  const meta = reconciliation.find((r) => r.platform === "meta");
  const withSpend = channels.filter((c) => c.spendCents > 0);
  const maxRevenue = Math.max(...channels.map((c) => c.attributedRevenueCents), 1);
  const maxTrendConv = Math.max(...trend.map((t) => t.platformConversions), 1);

  // Model/basis links must carry the range forward, or switching attribution model silently
  // resets the window to the default and the numbers move for two reasons at once.
  const href = (next: { model?: AttributionModel; basis?: AttributionBasis }) => {
    const q = new URLSearchParams();
    q.set("model", next.model ?? model);
    q.set("basis", next.basis ?? basis);
    q.set("range", range.preset);
    q.set("compare", compareMode);
    if (range.preset === "custom") {
      q.set("since", range.since);
      q.set("until", range.until);
    }
    return `/marketing?${q.toString()}`;
  };

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Marketing</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Blended efficiency, channel performance, and what the ad platforms claim versus what we
            can corroborate · {range.label}
            {range.clippedToDataStart ? " (clipped — data starts later than the range asked for)" : ""}
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

        {/* Every ratio below divides by spend, so a partial spend day flatters all of them.
            This is the page where saying so matters most. */}
        <FreshnessBanner freshness={freshness} sources={["meta", "shopify"]} />

        {/* ---- blended: needs no attribution, so it's the trustworthy headline ---- */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Polarity is declared per metric: MER up is good, CAC up is not. A comparison UI
              that paints every rise green teaches people to read CAC backwards. */}
          <Stat
            label="MER (blended)"
            value={x(period.mer)}
            hint={`${formatUsd(period.revenueCents, { compact: true })} revenue ÷ ${formatUsd(period.adSpendCents, { compact: true })} spend`}
            emphasis
            trailing={
              <DeltaBadge
                delta={d(period.mer, priorPeriod?.mer ?? null)}
                polarity="higher-is-better"
                format={(n) => `${n.toFixed(2)}×`}
                compareLabel={comparison?.label}
              />
            }
          />
          <Stat
            label="aMER (new customers)"
            value={x(period.amer)}
            hint={`${formatUsd(period.newCustomerRevenueCents, { compact: true })} from new customers`}
            trailing={
              <DeltaBadge
                delta={d(period.amer, priorPeriod?.amer ?? null)}
                polarity="higher-is-better"
                format={(n) => `${n.toFixed(2)}×`}
                compareLabel={comparison?.label}
              />
            }
          />
          <Stat
            label="Blended CAC"
            value={money(period.cac)}
            hint={`${formatNum(period.newCustomers)} new customers`}
            trailing={
              <DeltaBadge
                delta={d(period.cac, priorPeriod?.cac ?? null)}
                polarity="lower-is-better"
                format={(n) => formatUsd(n)}
                compareLabel={comparison?.label}
              />
            }
          />
          {/* Breakeven MER is derived from CM2, and its hint states the margin % outright,
              so it's withheld from roles without margin access. MER/aMER/CAC above are
              revenue-and-spend only and stay visible. */}
          {showMargin ? (
            <Stat
              label="Breakeven MER"
              value={x(breakeven)}
              hint={
                cmPct == null
                  ? "needs a margin figure"
                  : `at ${pct(cmPct)} CM2 margin, paid-order boundary`
              }
            />
          ) : (
            <Stat
              label="New customers"
              value={formatNum(period.newCustomers)}
              hint="first-time buyers in the window"
            />
          )}
        </div>

        {showMargin && period.mer != null && breakeven != null ? (
          <div
            className={`rounded-xl border p-4 text-sm ${
              period.mer >= breakeven
                ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                : "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            }`}
          >
            <strong>
              MER {x(period.mer)} against a {x(breakeven)} breakeven.
            </strong>{" "}
            {period.mer >= breakeven
              ? "Advertising is paying for itself on blended numbers — the margin covers the spend."
              : "Blended revenue isn't covering spend at the current contribution margin."}{" "}
            Blended metrics need no attribution at all, which is why they lead here: they can&rsquo;t
            be wrong about coverage. Both figures use the paid-order boundary; the Profit page uses a
            wider one that charges prepaid fulfilment against revenue recognised in an earlier
            period, so its margin reads lower. That difference is a revenue-recognition question, not
            a marketing one.
          </div>
        ) : null}

        {/* ---- the reconciliation surface (Section 8.4) ---- */}
        <Card
          title="Platform-reported vs our attribution"
          subtitle="Every platform grades its own homework. The gap bounds how much of its claim we can corroborate — it is not a scorecard for either side."
        >
          {reconciliation.length === 0 ? (
            <p className="text-sm text-neutral-500">No ad spend recorded in this window.</p>
          ) : (
            <div className="space-y-5">
              {reconciliation.map((r) => (
                <div key={r.platform} className="space-y-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium capitalize">{r.platform}</span>
                      <Badge tone="neutral">{formatUsd(r.spendCents)} spend</Badge>
                      {r.claimExceedsAllOrders ? (
                        <Badge tone="amber">platform data unusable</Badge>
                      ) : r.overclaimRatio != null && r.overclaimRatio > 2 ? (
                        <Badge tone="amber">claims {x(r.overclaimRatio, 1)} our count</Badge>
                      ) : null}
                    </div>
                    <span className="text-xs text-neutral-500">
                      {formatNum(r.impressions)} impressions · {formatNum(r.clicks)} clicks
                    </span>
                  </div>

                  {r.claimExceedsAllOrders ? (
                    <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                      <strong>
                        {r.platform}&rsquo;s stored conversion count is not usable.
                      </strong>{" "}
                      It claims {formatNum(Math.round(r.platformConversions))} purchases in a window
                      where the store took {formatNum(r.storeOrdersInWindow)} orders in total, from
                      every channel — a platform cannot drive more purchases than happened. The
                      connector previously summed Meta&rsquo;s overlapping{" "}
                      <code className="font-mono">omni_purchase</code>,{" "}
                      <code className="font-mono">purchase</code> and{" "}
                      <code className="font-mono">offsite_conversion.fb_pixel_purchase</code> action
                      types, inflating the figure roughly 3×. That is fixed in code, but{" "}
                      <strong>
                        these rows were written before the fix and need a re-sync to correct
                      </strong>
                      : <code className="font-mono">run.cmd backfill --source=ads</code>, which needs
                      a working <code className="font-mono">META_ACCESS_TOKEN</code> (the current one
                      returns &ldquo;API access blocked&rdquo;). Until then treat every{" "}
                      {r.platform}-side figure below as void; our own attribution and the blended
                      metrics are unaffected.
                    </div>
                  ) : null}

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Stat
                      label={`${r.platform} claims`}
                      value={
                        r.claimExceedsAllOrders
                          ? "—"
                          : formatNum(Math.round(r.platformConversions))
                      }
                      hint={
                        r.claimExceedsAllOrders
                          ? `${formatNum(Math.round(r.platformConversions))} stored, rejected as impossible`
                          : `conversions · ${formatUsd(r.platformConversionValueCents, { compact: true })} value · ROAS ${x(r.platformRoas)}`
                      }
                    />
                    <Stat
                      label="We can see"
                      value={formatNum(Math.round(r.ourConversions))}
                      hint={`conversions · ${formatUsd(r.ourRevenueCents, { compact: true })} credited · ROAS ${x(r.ourRoas)}`}
                    />
                    <Stat
                      label="Unprovable but plausible"
                      value={formatNum(Math.round(r.ambiguousConversions))}
                      hint={`untagged social from ${r.platform} hosts · ${formatUsd(r.ambiguousRevenueCents, { compact: true })}`}
                    />
                    <Stat
                      label="ROAS band"
                      value={`${x(r.ourRoas)} – ${x(r.ceilingRoas)}`}
                      hint="floor = provable only; ceiling = every ambiguous order was paid"
                    />
                  </div>

                  <div className="rounded-lg bg-neutral-100/70 p-3 text-xs text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
                    {r.claimExceedsAllOrders ? (
                      <>
                        <strong>What we can still say:</strong> our own attribution credits{" "}
                        {formatNum(Math.round(r.ourConversions))} conversions and{" "}
                        {formatUsd(r.ourRevenueCents)} to {r.platform}, with a further{" "}
                        {formatNum(Math.round(r.ambiguousConversions))} untagged social orders that
                        may belong to it. That puts real ROAS somewhere in {x(r.ourRoas)}–
                        {x(r.ceilingRoas)} and CAC at {money(r.ourCac)} or better. The comparison
                        against {r.platform}&rsquo;s own claim has to wait for a re-sync.
                      </>
                    ) : r.gapExplainableByUntagged ? (
                      <>
                        <strong>Untagged traffic can fully explain the gap.</strong> Our{" "}
                        {formatNum(Math.round(r.ourConversions))} provable plus{" "}
                        {formatNum(Math.round(r.ambiguousConversions))} ambiguous conversions reach{" "}
                        {r.platform}&rsquo;s {formatNum(Math.round(r.platformConversions))}. The
                        measurement gap is a tagging problem, not evidence the platform is inflating.
                      </>
                    ) : (
                      <>
                        <strong>
                          A {formatNum(Math.round(Math.abs(r.deltaAbsolute)))}-conversion gap remains
                          unexplained.
                        </strong>{" "}
                        Even crediting every ambiguous social order to {r.platform}, its claim of{" "}
                        {formatNum(Math.round(r.platformConversions))} exceeds the{" "}
                        {formatNum(Math.round(r.ourConversions + r.ambiguousConversions))} we can
                        reach. The remainder is view-through and cross-device conversion we have no
                        way to observe — treat {r.platform}&rsquo;s ROAS as its own claim.
                      </>
                    )}{" "}
                    {r.claimExceedsAllOrders
                      ? null
                      : `CAC reads ${money(r.platformCac)} their way and ${money(r.ourCac)} ours.`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {meta && meta.ambiguousConversions > 0 ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>Tag your links and most of this uncertainty disappears.</strong> Meta clicks
            arrive without an <code className="font-mono">fbclid</code> or a{" "}
            <code className="font-mono">utm_medium</code>, so they&rsquo;re indistinguishable from
            organic Instagram reach and land in <code className="font-mono">organic-social</code>.
            That&rsquo;s why attributed ROAS reads {x(meta.ourRoas)} while blended MER reads{" "}
            {x(period.mer)}. Adding <code className="font-mono">?utm_source=meta&amp;utm_medium=paid_social</code>{" "}
            to ad destinations collapses the {x(meta.ourRoas)}–{x(meta.ceilingRoas)} band to a single
            number. Until then, <strong>trust MER directionally and treat attributed ROAS as a
            measure of our coverage, not Meta&rsquo;s performance.</strong>
          </div>
        ) : null}

        {/* ---- model toggle + channel table ---- */}
        <Card
          title="Channel performance"
          subtitle="Revenue is apportioned across each order's touchpoint path, so the split changes with the model. Sharp disagreement between models means a channel's real contribution is uncertain."
        >
          <div className="mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-neutral-500">Model</span>
              {MODELS.map((m) => (
                <Link
                  key={m.id}
                  href={href({ model: m.id })}
                  title={m.blurb}
                  className={`rounded-lg px-2.5 py-1 text-xs transition ${
                    m.id === model
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  }`}
                >
                  {m.label}
                </Link>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-neutral-500">Basis</span>
              {BASES.map((b) => (
                <Link
                  key={b.id}
                  href={href({ basis: b.id })}
                  className={`rounded-lg px-2.5 py-1 text-xs transition ${
                    b.id === basis
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  }`}
                >
                  {b.label}
                </Link>
              ))}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {MODELS.find((m) => m.id === model)?.blurb}.{" "}
              {basis === "inherit-from-customer"
                ? "Revenue with no session of its own (API-created renewals, Stripe invoices) is credited to that customer's known acquisition channel — inference, shown separately below."
                : "Only revenue with its own observed session is credited; renewals created by API are left unattributed."}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 text-right font-medium">Attributed revenue</th>
                  <th className="pb-2 text-right font-medium">Conversions</th>
                  <th className="pb-2 text-right font-medium">Spend</th>
                  <th className="pb-2 text-right font-medium">ROAS</th>
                  <th className="pb-2 text-right font-medium">CAC</th>
                  {basis === "inherit-from-customer" ? (
                    <th className="pb-2 text-right font-medium">of which inherited</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {channels.map((c) => (
                  <tr key={c.channel}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.channel}</span>
                        {isPaid(c.channel) ? <Badge tone="blue">paid</Badge> : null}
                        {c.channel === "organic-social" &&
                        meta &&
                        meta.ambiguousConversions > 0 ? (
                          <Badge tone="amber">may contain untagged ads</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 h-1 w-32 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                        <div
                          className="h-full bg-neutral-400 dark:bg-neutral-500"
                          style={{
                            width: `${Math.max((c.attributedRevenueCents / maxRevenue) * 100, 0)}%`,
                          }}
                        />
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsd(c.attributedRevenueCents)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatNum(Math.round(c.attributedConversions))}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {c.spendCents ? formatUsd(c.spendCents) : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">{x(c.roas)}</td>
                    <td className="py-2 text-right tabular-nums">{money(c.cac)}</td>
                    {basis === "inherit-from-customer" ? (
                      <td className="py-2 text-right text-xs tabular-nums text-neutral-500">
                        {c.inheritedRevenueCents
                          ? formatUsd(c.inheritedRevenueCents, { compact: true })
                          : "—"}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {withSpend.length === 0 ? (
            <p className="mt-4 text-xs text-neutral-500">
              No channel in this window has both spend and attributed revenue, so ROAS is
              unavailable throughout — the blended MER above is the only usable return figure.
            </p>
          ) : null}
        </Card>

        {/* ---- coverage: the honesty check on everything above ---- */}
        <Card
          title="Attribution coverage"
          subtitle="How much revenue the table above can actually speak to. A confident-looking split over thin coverage is the failure mode this card exists to prevent."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Coverage of all revenue"
              value={pct(coverage.coveragePct)}
              hint={`${formatNum(coverage.ordersWithTouchpoints)} of ${formatNum(coverage.ordersTotal)} orders have a journey`}
            />
            <Stat
              label="Coverage of addressable"
              value={pct(coverage.coverageOfAddressablePct)}
              hint="excludes orders that could never have had a session"
            />
            <Stat
              label="No session possible"
              value={formatNum(coverage.ordersNoSessionPossible)}
              hint={`${formatUsd(coverage.revenueNoSessionPossibleCents, { compact: true })} — API renewals and $0 orders`}
            />
            <Stat
              label="Avg path length"
              value={coverage.avgPathLength.toFixed(2)}
              hint={`${formatUsd(coverage.revenueInheritableCents, { compact: true })} recoverable by inheritance`}
            />
          </div>
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            Orders with no journey are excluded from the channel table rather than dumped into
            &ldquo;direct&rdquo;, which would inflate direct and make coverage look complete when it
            isn&rsquo;t. The addressable figure is the fairer denominator: renewals created by API
            never had a browsing session and never will.
          </p>
        </Card>

        {/* ---- platform trend ---- */}
        {trend.length > 1 ? (
          <Card
            title="Meta: spend and self-reported conversions by month"
            subtitle="A single window can't tell a persistent measurement gap from a one-month blip"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                    <th className="pb-2 font-medium">Month</th>
                    <th className="pb-2 text-right font-medium">Spend</th>
                    <th className="pb-2 text-right font-medium">Claimed conversions</th>
                    <th className="pb-2 text-right font-medium">Claimed value</th>
                    <th className="pb-2 text-right font-medium">Claimed ROAS</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {trend.map((t) => (
                    <tr key={t.month}>
                      <td className="py-2 tabular-nums">{t.month}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(t.spendCents)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatNum(Math.round(t.platformConversions))}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatUsd(t.platformConversionValueCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {x(
                          t.spendCents > 0
                            ? t.platformConversionValueCents / t.spendCents
                            : null,
                        )}
                      </td>
                      <td className="w-32 py-2">
                        <div className="h-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                          <div
                            className="h-full bg-neutral-400 dark:bg-neutral-500"
                            style={{
                              width: `${(t.platformConversions / maxTrendConv) * 100}%`,
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </main>
    </div>
  );
}

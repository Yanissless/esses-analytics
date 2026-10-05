import Link from "next/link";
import { requireCapability } from "@/lib/auth/current-user";
import {
  getDataQuality,
  getMonthlyRevenue,
  getOrderMix,
  getRevenueSummary,
  getSubscriptionHealth,
  getTopCustomers,
} from "@/metrics/overview";
import { getPeriodMetrics } from "@/metrics/rollup";
import { resolvePageRange } from "@/lib/date-range.server";
import { delta } from "@/lib/date-range";
import { RevenueChart } from "./_components/revenue-chart";
import { Nav } from "./_components/nav";
import { DateRangePicker } from "./_components/date-range-picker";
import { Badge, Card, DeltaBadge, Stat, formatNum, formatUsd } from "./_components/ui";

export const dynamic = "force-dynamic";

const ORDER_TYPE_LABELS: Record<string, string> = {
  one_time: "One-time orders",
  subscription_shopify: "Skio subscription orders",
  subscription_stripe_fulfillment: "Stripe fulfillment (excluded)",
};

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireCapability("revenue");
  // Defaults to "all time" — the range this page has always shown — so adding the
  // picker doesn't change what anyone sees today; it just lets them narrow to a
  // day/week/month/year from here instead of navigating to a page that has one.
  const { range, compareMode, comparison, bounds } = await resolvePageRange(
    await searchParams,
    "all",
  );
  const since = range.since;
  const until = range.until;

  const [summary, monthly, mix, subs, quality, topCustomers] = await Promise.all([
    getRevenueSummary(since, until),
    getMonthlyRevenue(since, until),
    getOrderMix(since, until),
    getSubscriptionHealth(),
    getDataQuality(),
    getTopCustomers(10, since, until),
  ]);

  // Efficiency and margin come from the daily_metrics rollup (Section 9) rather
  // than being recomputed per page load.
  const [period, priorSummary, priorPeriod] = await Promise.all([
    getPeriodMetrics(since, until),
    comparison ? getRevenueSummary(comparison.since, comparison.until) : Promise.resolve(null),
    comparison ? getPeriodMetrics(comparison.since, comparison.until) : Promise.resolve(null),
  ]);
  // Only worth showing once the comparison window is fully inside the data —
  // otherwise "down 40%" is really "we don't have last year's Q1 yet".
  const canCompare = comparison !== null && !comparison.partial;
  const d = (cur: number | null, prev: number | null) =>
    canCompare && cur != null && prev != null ? delta(cur, prev) : null;

  const ratioText = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits));
  const pctText = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

  const cogsPct = quality.totalLineItems
    ? Math.round((quality.lineItemsMissingCogs / quality.totalLineItems) * 100)
    : 0;

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      {/* The shared nav, not a local header. This page hand-rolled its own copy, and because
          that copy carried no link list, `/` — where landingPathFor sends every admin and
          viewer — had no navigation at all. */}
      <Nav email={user.email} role={user.role} />

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              All revenue sources unified · {range.label}
            </p>
          </div>
          {/* A link, not an instruction. This used to end "Run `pnpm review`", which is a
              reasonable thing to tell the person who wrote it and useless to everyone else —
              so in practice the queue never got cleared and the money stayed out of revenue. */}
          {quality.pendingReviewOrders > 0 ? (
            <Link
              href="/review"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 transition hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-950"
            >
              <strong>{quality.pendingReviewOrders} order(s)</strong> awaiting review (
              {formatUsd(quality.pendingReviewCents)}) — held out of revenue until confirmed.{" "}
              <span className="underline decoration-dotted underline-offset-2">
                Review them now →
              </span>
            </Link>
          ) : null}
        </div>

        <DateRangePicker
          preset={range.preset}
          compareMode={compareMode}
          since={range.since}
          until={range.until}
          anchor={bounds.anchor}
          dataStart={bounds.start}
          lagDays={bounds.lagDays}
          comparisonUnavailable={comparison === null || comparison.partial}
        />

        {/* Headline numbers */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Total revenue (net)"
            value={formatUsd(summary.combinedNetCents)}
            hint="Shopify + Stripe, refunds deducted"
            emphasis
            trailing={
              <DeltaBadge
                delta={d(summary.combinedNetCents, priorSummary?.combinedNetCents ?? null)}
                polarity="higher-is-better"
                format={(n) => formatUsd(n)}
                compareLabel={comparison?.label}
              />
            }
          />
          <Stat
            label="Shopify orders (net)"
            value={formatUsd(summary.shopifyNetCents)}
            hint={`${formatNum(summary.paidOrderCount)} paid orders · AOV ${formatUsd(summary.aovCents)}`}
            trailing={
              <DeltaBadge
                delta={d(summary.shopifyNetCents, priorSummary?.shopifyNetCents ?? null)}
                polarity="higher-is-better"
                format={(n) => formatUsd(n)}
                compareLabel={comparison?.label}
              />
            }
          />
          <Stat
            label="Stripe subscriptions"
            value={formatUsd(summary.stripePaidCents)}
            hint="Print subscriptions, paid invoices"
            trailing={
              <DeltaBadge
                delta={d(summary.stripePaidCents, priorSummary?.stripePaidCents ?? null)}
                polarity="higher-is-better"
                format={(n) => formatUsd(n)}
                compareLabel={comparison?.label}
              />
            }
          />
          <Stat
            label="Active MRR"
            value={formatUsd(subs.combinedMrrCents)}
            hint={`${formatNum(subs.skioActive + subs.stripeActive)} active subscribers · current, not scoped to the range above`}
          />
        </div>

        <Card
          title="Profit & marketing efficiency"
          subtitle="From the daily_metrics rollup · CM3 is after ad spend"
        >
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label="CM1"
              value={formatUsd(period.cm1Cents)}
              hint="after COGS"
              trailing={
                <DeltaBadge
                  delta={d(period.cm1Cents, priorPeriod?.cm1Cents ?? null)}
                  polarity="higher-is-better"
                  format={(n) => formatUsd(n)}
                  compareLabel={comparison?.label}
                />
              }
            />
            <Stat
              label="CM2"
              value={formatUsd(period.cm2Cents)}
              hint="after fulfilment"
              trailing={
                <DeltaBadge
                  delta={d(period.cm2Cents, priorPeriod?.cm2Cents ?? null)}
                  polarity="higher-is-better"
                  format={(n) => formatUsd(n)}
                  compareLabel={comparison?.label}
                />
              }
            />
            <Stat
              label="CM3"
              value={formatUsd(period.cm3Cents)}
              hint={`${pctText(period.cm3Pct)} after ad spend`}
              trailing={
                <DeltaBadge
                  delta={d(period.cm3Cents, priorPeriod?.cm3Cents ?? null)}
                  polarity="higher-is-better"
                  format={(n) => formatUsd(n)}
                  compareLabel={comparison?.label}
                />
              }
            />
            <Stat
              label="MER"
              value={ratioText(period.mer)}
              hint="revenue ÷ ad spend"
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
              label="aMER"
              value={ratioText(period.amer)}
              hint="new-cust rev ÷ spend"
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
              label="CAC"
              value={period.cac == null ? "—" : formatUsd(period.cac)}
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
          </div>
          {period.adSpendCents === 0 ? (
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              MER, aMER and CAC read &ldquo;—&rdquo; because no ad spend is loaded yet — they
              populate automatically once the Meta connector has credentials. A zero would have
              read as flawless efficiency, which is why these show as not-measurable instead.
            </p>
          ) : null}
        </Card>

        <Card
          title="Monthly revenue"
          subtitle="Stacked: Shopify order revenue and Stripe subscription payments"
        >
          <RevenueChart data={monthly} />
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Revenue mix" subtitle="By order type — fulfillment proxies excluded from revenue">
            <ul className="space-y-3">
              {mix.map((m) => {
                const pct = summary.shopifyNetCents
                  ? Math.round((m.netCents / summary.shopifyNetCents) * 100)
                  : 0;
                return (
                  <li key={m.orderType}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-neutral-700 dark:text-neutral-300">
                        {ORDER_TYPE_LABELS[m.orderType] ?? m.orderType}
                      </span>
                      <span className="tabular-nums font-medium">{formatUsd(m.netCents)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                      <div className="h-full rounded-full bg-neutral-900 dark:bg-neutral-100" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {formatNum(m.orders)} orders · {pct}% of Shopify revenue
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Subscription health" subtitle="Skio (via Shopify) and Stripe (print), tracked separately">
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Skio active"
                value={formatNum(subs.skioActive)}
                hint={`${formatUsd(subs.skioMrrCents)} MRR · ${formatNum(subs.skioCanceled)} canceled`}
              />
              <Stat
                label="Stripe active"
                value={formatNum(subs.stripeActive)}
                hint={`${formatUsd(subs.stripeMrrCents)} MRR · ${formatNum(subs.stripeCanceled)} canceled`}
              />
            </div>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              Skio contributes no separate revenue — its renewals are already counted as Shopify
              orders. It supplies plan, churn, and MRR context only.
            </p>
          </Card>
        </div>

        <Card
          title="Top customers by lifetime value"
          subtitle="Unified across Shopify orders and Stripe subscriptions"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Customer</th>
                  <th className="pb-2 text-right font-medium">Orders</th>
                  <th className="pb-2 text-right font-medium">Shopify</th>
                  <th className="pb-2 text-right font-medium">Stripe</th>
                  <th className="pb-2 text-right font-medium">Total LTV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {/* Index as the last-resort key. Math.random() here produced a fresh key
                    on every render, remounting the row and defeating reconciliation. */}
                {topCustomers.map((c, i) => (
                  <tr key={c.email ?? c.name ?? `customer-${i}`}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.name ?? "(no name)"}</span>
                        {c.isSubscriber ? <Badge tone="emerald">subscriber</Badge> : null}
                      </div>
                      <div className="text-xs text-neutral-500">{c.email ?? "—"}</div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatNum(c.orders)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(c.shopifyNetCents)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(c.stripePaidCents)}</td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {formatUsd(c.totalCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Data quality" subtitle="What's counted, what isn't, and what's still missing">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <dt className="text-xs text-neutral-500">Fulfillment orders excluded</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">
                {formatNum(quality.excludedFulfillmentOrders)}
              </dd>
              <dd className="text-xs text-neutral-500">
                {formatUsd(quality.excludedFulfillmentNominalCents)} nominal — real money is in Stripe
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Orders awaiting review</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">
                {formatNum(quality.pendingReviewOrders)}
              </dd>
              <dd className="text-xs text-neutral-500">
                {formatUsd(quality.pendingReviewCents)} held out of revenue
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">$0 fulfillment orders</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">
                {formatNum(summary.zeroValueOrderCount)}
              </dd>
              <dd className="text-xs text-neutral-500">
                prepaid deliveries &amp; comps — excluded from AOV, not from revenue
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Subscription-linked orders</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">
                {formatNum(quality.linkedSubscriptionOrders)}
              </dd>
              <dd className="text-xs text-neutral-500">matched to a Skio subscription</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Line items missing COGS</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">{cogsPct}%</dd>
              <dd className="text-xs text-neutral-500">
                {cogsPct === 100
                  ? "no costs loaded yet — margin unavailable (Phase 4)"
                  : `${formatNum(quality.lineItemsMissingCogs)} of ${formatNum(quality.totalLineItems)} lines`}
              </dd>
            </div>
          </dl>

          <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <div className="mb-2 text-xs text-neutral-500">Last sync per source</div>
            <div className="flex flex-wrap gap-2">
              {quality.lastSyncs.map((s) => (
                <span
                  key={s.source}
                  className="rounded-lg border border-neutral-200 px-2.5 py-1 text-xs dark:border-neutral-800"
                >
                  <span className="font-medium">{s.source}</span>{" "}
                  <Badge tone={s.status === "success" ? "emerald" : s.status === "failed" ? "amber" : "blue"}>
                    {s.status}
                  </Badge>{" "}
                  <span className="text-neutral-500">
                    {formatNum(s.rows)} rows{s.finishedAt ? ` · ${s.finishedAt}` : ""}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </Card>

        <p className="pb-4 text-xs text-neutral-400">
          Margin (CM1/CM2/CM3), CAC/MER, attribution, and forecasting arrive in later phases. COGS
          data is required before any margin number can be trusted.
        </p>
      </main>
    </div>
  );
}

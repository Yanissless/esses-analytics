import { requireUser } from "@/lib/auth/current-user";
import {
  getDataQuality,
  getMonthlyRevenue,
  getOrderMix,
  getRevenueSummary,
  getSubscriptionHealth,
  getTopCustomers,
} from "@/metrics/overview";
import { getPeriodMetrics } from "@/metrics/rollup";
import { logout } from "./login/actions";
import { RevenueChart } from "./_components/revenue-chart";
import { Badge, Card, Stat, formatNum, formatUsd } from "./_components/ui";

export const dynamic = "force-dynamic";

const ORDER_TYPE_LABELS: Record<string, string> = {
  one_time: "One-time orders",
  subscription_shopify: "Skio subscription orders",
  subscription_stripe_fulfillment: "Stripe fulfillment (excluded)",
};

export default async function Overview() {
  const user = await requireUser();
  const [summary, monthly, mix, subs, quality, topCustomers] = await Promise.all([
    getRevenueSummary(),
    getMonthlyRevenue(),
    getOrderMix(),
    getSubscriptionHealth(),
    getDataQuality(),
    getTopCustomers(10),
  ]);

  // Efficiency and margin come from the daily_metrics rollup (Section 9) rather
  // than being recomputed per page load.
  const period = await getPeriodMetrics(
    summary.firstOrderDate ?? "2025-01-01",
    summary.lastOrderDate ?? new Date().toISOString().slice(0, 10),
  );
  const ratioText = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits));
  const pctText = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

  const cogsPct = quality.totalLineItems
    ? Math.round((quality.lineItemsMissingCogs / quality.totalLineItems) * 100)
    : 0;
  const initial = (user.name ?? user.email).charAt(0).toUpperCase();
  const range =
    summary.firstOrderDate && summary.lastOrderDate
      ? `${summary.firstOrderDate} → ${summary.lastOrderDate}`
      : "no orders yet";

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight">Esses Analytics</span>
            <Badge>internal</Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-sm text-neutral-700 dark:text-neutral-300">{user.email}</div>
              <div className="text-[11px] uppercase tracking-wide text-neutral-400">{user.role}</div>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
              {initial}
            </div>
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              All revenue sources unified · {range}
            </p>
          </div>
          {quality.pendingReviewOrders > 0 ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              <strong>{quality.pendingReviewOrders} order(s)</strong> awaiting review (
              {formatUsd(quality.pendingReviewCents)}) — excluded until confirmed. Run{" "}
              <code className="font-mono">pnpm review</code>
            </div>
          ) : null}
        </div>

        {/* Headline numbers */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Total revenue (net)"
            value={formatUsd(summary.combinedNetCents)}
            hint="Shopify + Stripe, refunds deducted"
            emphasis
          />
          <Stat
            label="Shopify orders (net)"
            value={formatUsd(summary.shopifyNetCents)}
            hint={`${formatNum(summary.paidOrderCount)} paid orders · AOV ${formatUsd(summary.aovCents)}`}
          />
          <Stat
            label="Stripe subscriptions"
            value={formatUsd(summary.stripePaidCents)}
            hint="Print subscriptions, paid invoices"
          />
          <Stat
            label="Active MRR"
            value={formatUsd(subs.combinedMrrCents)}
            hint={`${formatNum(subs.skioActive + subs.stripeActive)} active subscribers`}
          />
        </div>

        <Card
          title="Profit & marketing efficiency"
          subtitle="From the daily_metrics rollup · CM3 is after ad spend"
        >
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="CM1" value={formatUsd(period.cm1Cents)} hint="after COGS" />
            <Stat label="CM2" value={formatUsd(period.cm2Cents)} hint="after fulfilment" />
            <Stat
              label="CM3"
              value={formatUsd(period.cm3Cents)}
              hint={`${pctText(period.cm3Pct)} after ad spend`}
            />
            <Stat label="MER" value={ratioText(period.mer)} hint="revenue ÷ ad spend" />
            <Stat label="aMER" value={ratioText(period.amer)} hint="new-cust rev ÷ spend" />
            <Stat
              label="CAC"
              value={period.cac == null ? "—" : formatUsd(period.cac)}
              hint={`${formatNum(period.newCustomers)} new customers`}
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
                {topCustomers.map((c) => (
                  <tr key={(c.email ?? c.name) ?? Math.random().toString()}>
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

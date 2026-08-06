import { requireCapability } from "@/lib/auth/current-user";
import {
  getCohorts,
  getLtvByChannel,
  getLtvSummary,
  getRetentionCurve,
  getSubscriptionRetention,
} from "@/metrics/ltv";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (v: number | null) => (v == null ? "—" : formatUsd(v));

export default async function CustomersPage() {
  const user = await requireCapability("customers");
  const [summary, cohorts, byChannel, retention, curve] = await Promise.all([
    getLtvSummary(),
    getCohorts(),
    getLtvByChannel(),
    getSubscriptionRetention(),
    getRetentionCurve(12),
  ]);

  const matureCohorts = cohorts.filter((c) => c.isMature);
  const maxCohortValue = Math.max(...cohorts.map((c) => c.totalValueCents), 1);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Customers &amp; LTV</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Lifetime value unified across Shopify orders (one-time + Skio) and Stripe subscriptions
            — one number per person, not per system.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Blended LTV"
            value={money(summary.blendedLtvCents)}
            hint={`${formatNum(summary.customersWithValue)} paying customers`}
            emphasis
          />
          <Stat
            label="Subscriber LTV"
            value={money(summary.subscriberLtvCents)}
            hint="Skio or Stripe subscribers"
          />
          <Stat
            label="One-time buyer LTV"
            value={money(summary.nonSubscriberLtvCents)}
            hint="never subscribed"
          />
          <Stat
            label="Subscriber premium"
            value={
              summary.subscriberMultiple == null
                ? "—"
                : `${summary.subscriberMultiple.toFixed(1)}×`
            }
            hint="how much more a subscriber is worth"
          />
        </div>

        {summary.customersZeroValue > 0 ? (
          <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <strong>{formatNum(summary.customersZeroValue)} customers have $0 lifetime value</strong>{" "}
            — comp recipients (contributor, VIP, watch-party copies). They&rsquo;re excluded from the
            LTV averages above; including them would make paying customers look less valuable than
            they are.
          </div>
        ) : null}

        <Card
          title="Subscription health &amp; predictive LTV"
          subtitle="Churn is cumulative (cancelled ÷ ever-started) — with under a year of history a monthly rate would swing too wildly to trust"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">System</th>
                  <th className="pb-2 text-right font-medium">Active</th>
                  <th className="pb-2 text-right font-medium">Cancelled</th>
                  <th className="pb-2 text-right font-medium">Churn</th>
                  <th className="pb-2 text-right font-medium">Avg lifetime</th>
                  <th className="pb-2 text-right font-medium">MRR</th>
                  <th className="pb-2 text-right font-medium">Predictive LTV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {retention.map((r) => (
                  <tr key={r.source}>
                    <td className="py-2 font-medium capitalize">{r.source}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(r.active)}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(r.canceled)}</td>
                    <td
                      className={`py-2 text-right tabular-nums ${
                        (r.churnRatePct ?? 0) > 0.3 ? "text-amber-600 dark:text-amber-400" : ""
                      }`}
                    >
                      {pct(r.churnRatePct)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.avgLifetimeMonths == null ? "—" : `${r.avgLifetimeMonths.toFixed(1)} mo`}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(r.mrrCents)}</td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {money(r.predictiveLtvCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Retention curve"
          subtitle="Share still active N months after starting — only counts subscriptions old enough to have reached each month"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Month</th>
                  {curve.map((p) => (
                    <th key={p.monthsSinceStart} className="pb-2 text-right font-medium tabular-nums">
                      {p.monthsSinceStart}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                <tr>
                  <td className="py-2 font-medium">Skio</td>
                  {curve.map((p) => (
                    <td key={p.monthsSinceStart} className="py-2 text-right tabular-nums">
                      {pct(p.skioRetainedPct)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 font-medium">Stripe</td>
                  {curve.map((p) => (
                    <td key={p.monthsSinceStart} className="py-2 text-right tabular-nums">
                      {pct(p.stripeRetainedPct)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="LTV by acquisition cohort"
          subtitle="Trend the LTV @ 3mo column, not LTV to date — the latter rises with cohort age simply because older cohorts have had longer to accumulate, which reads as 'LTV is collapsing' when it isn't."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Cohort</th>
                  <th className="pb-2 text-right font-medium">Custs</th>
                  <th className="pb-2 text-right font-medium">Sub %</th>
                  <th className="pb-2 text-right font-medium">LTV to date</th>
                  <th className="pb-2 text-right font-medium">LTV @ 3mo</th>
                  <th className="pb-2 text-right font-medium">12-mo LTV</th>
                  <th className="pb-2 text-right font-medium">One-time</th>
                  <th className="pb-2 text-right font-medium">Skio</th>
                  <th className="pb-2 text-right font-medium">Stripe</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {cohorts.map((c) => {
                  const oneTime = c.shopifyValueCents - c.skioValueCents;
                  const stripeTotal = c.stripePrintValueCents + c.stripeDigitalValueCents;
                  return (
                    <tr key={c.cohortMonth}>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium tabular-nums">{c.cohortMonth}</span>
                          {!c.isMature ? (
                            <Badge tone="neutral">{c.monthsObserved}mo</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatNum(c.customers)}</td>
                      <td className="py-2 text-right tabular-nums">{pct(c.subscriberPct)}</td>
                      <td className="py-2 text-right tabular-nums text-neutral-500">
                        {money(c.ltvCents)}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {money(c.ltvAt3MonthsCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-neutral-500">
                        {money(c.ltv12MonthCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(oneTime)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatUsd(c.skioValueCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(stripeTotal)}</td>
                      <td className="py-2">
                        <div className="flex items-center justify-end gap-2">
                          <span className="tabular-nums">{formatUsd(c.totalValueCents)}</span>
                          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100 sm:block dark:bg-neutral-800">
                            <span
                              className="block h-full rounded-full bg-neutral-900 dark:bg-neutral-100"
                              style={{ width: `${(c.totalValueCents / maxCohortValue) * 100}%` }}
                            />
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {matureCohorts.length === 0 ? (
            <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
              No cohort has reached 12 months yet, so every 12-month LTV reads &ldquo;—&rdquo;. The
              first will mature in {12 - Math.max(...cohorts.map((c) => c.monthsObserved), 0)} month(s).
            </p>
          ) : null}
        </Card>

        <Card
          title="LTV by acquisition channel"
          subtitle="Which channels bring customers worth having — not just the cheapest clicks"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 text-right font-medium">Customers</th>
                  <th className="pb-2 text-right font-medium">Subscriber %</th>
                  <th className="pb-2 text-right font-medium">Avg orders</th>
                  <th className="pb-2 text-right font-medium">LTV</th>
                  <th className="pb-2 text-right font-medium">Total value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {byChannel.map((c) => (
                  <tr key={c.channel}>
                    <td className="py-2 font-medium">{c.channel}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(c.customers)}</td>
                    <td className="py-2 text-right tabular-nums">{pct(c.subscriberPct)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {c.avgOrders == null ? "—" : c.avgOrders.toFixed(1)}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">{money(c.ltvCents)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsd(c.totalValueCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            &ldquo;(unattributed)&rdquo; covers customers acquired before journey tracking or whose
            visit carried no usable signal — see the attribution coverage figures.
          </p>
        </Card>
      </main>
    </div>
  );
}

import Link from "next/link";
import { requireCapability } from "@/lib/auth/current-user";
import {
  getMonthlyTenure,
  getPurchaseFrequency,
  getRouteConversions,
  getTenureSummary,
  MATURITY_DAYS,
  MIN_COHORT_TO_RATE,
  type AcquisitionRoute,
} from "@/metrics/customer-tenure";
import { Card, Caveat, InfoTip, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

/**
 * First-time buyers versus repeat buyers, counted on money rather than orders.
 *
 * The rollup's existing `returning_orders` cannot answer this: 61% of non-acquisition orders
 * collected nothing (3,375 prepaid deliveries, 414 comps out of 6,212), so an annual subscriber
 * receiving four delivery orders reads as a five-order repeat customer having paid once. See the
 * note in metrics/customer-tenure.ts.
 */

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

const ROUTE_LABEL: Record<AcquisitionRoute, string> = {
  paid: "Paid for their first issue",
  acquisition_gift: "Given a free first issue",
  prepaid_delivery: "Migrated — paid on Craft/Stripe",
  comp: "Comp or VIP copy",
};

const ROUTE_NOTE: Record<AcquisitionRoute, string> = {
  paid: "The baseline. Acquired by paying, so conversion is 100% by definition — it is here to compare the free routes against.",
  acquisition_gift:
    "The free-first-issue offer. This rate is the whole question about whether the offer works: a gift that never converts is an acquisition cost with nothing behind it.",
  prepaid_delivery:
    "Their earliest Shopify order is a shipment against money taken on the other platform. Not first-time customers — migrated ones whose purchase history lives elsewhere, which is why they are counted separately rather than called new.",
  comp: "Given away with no expectation of revenue — press, contributor and VIP copies. A low rate here is the intended outcome, not a failure.",
};

export default async function RepeatPage() {
  const user = await requireCapability("customers");

  const [summary, frequency, routes, monthly] = await Promise.all([
    getTenureSummary(),
    getPurchaseFrequency(6),
    getRouteConversions(),
    getMonthlyTenure(12),
  ]);

  const maxFreq = Math.max(...frequency.map((f) => f.customers), 1);
  const maxMonth = Math.max(...monthly.map((m) => m.firstPurchases + m.repeatPurchases), 1);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">First-time vs repeat buyers</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Counted on purchases that collected money, not on orders.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Repeat buyers"
            value={formatNum(summary.repeatBuyers)}
            hint={`${pct(summary.repeatRate)} of everyone who has ever paid`}
            emphasis
          />
          <Stat
            label="Bought once only"
            value={formatNum(summary.firstTimeOnly)}
            hint="one paid purchase to date"
          />
          <Stat
            label="Repeat share of revenue"
            value={pct(summary.repeatRevenueShare)}
            hint={`${formatUsd(summary.repeatPurchaseCents)} of ${formatUsd(summary.firstPurchaseCents + summary.repeatPurchaseCents)}`}
          />
          <Stat
            label="Never paid anything"
            value={formatNum(summary.neverPaid)}
            hint="free issues, comps, and deliveries paid elsewhere"
          />
        </div>

        <Caveat summary="Repeat means paid more than once — not ordered more than once.">
          The two are very different here. Of 6,212 orders that are not a customer&rsquo;s first,
          <strong> 3,375 are prepaid deliveries and 414 are comps</strong> — 61% collected no
          money. An annual subscriber receives four delivery orders a year, so counting orders
          would read them as a five-order repeat customer having paid once, and inflate the repeat
          rate roughly two and a half times. Every figure on this page counts paid purchases.
        </Caveat>

        <Card
          title="How many times people have paid"
          subtitle={`${formatNum(summary.payingCustomers)} customers have paid at least once`}
          info="Only customers who have paid appear here. Someone who has received a free issue and nothing else has made no purchases, so including them would make the first bar meaningless."
        >
          <div className="space-y-2">
            {frequency.map((f) => (
              <div key={f.paidPurchases} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 text-neutral-600 dark:text-neutral-400">
                  {f.paidPurchases === 6 ? "6 or more" : `${f.paidPurchases} purchase${f.paidPurchases === 1 ? "" : "s"}`}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                  <div
                    className={
                      f.paidPurchases === 1
                        ? "h-full rounded bg-neutral-400 dark:bg-neutral-600"
                        : "h-full rounded bg-emerald-500"
                    }
                    style={{ width: `${(f.customers / maxFreq) * 100}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right tabular-nums font-medium">
                  {formatNum(f.customers)}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Did they ever pay, by how they arrived"
          subtitle={`Rates measured on customers acquired more than ${MATURITY_DAYS} days ago`}
          info={
            `A free first issue converts when the customer pays for the next one, roughly a ` +
            `quarter later. Someone who signed up last week has not declined — they have not ` +
            `been asked yet — so the rates divide by the matured cohort only. Rates are ` +
            `withheld below ${MIN_COHORT_TO_RATE} matured customers.`
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 pr-4 font-medium">How they arrived</th>
                  <th className="pb-2 pr-4 text-right font-medium">Customers</th>
                  <th className="pb-2 pr-4 text-right font-medium">Matured</th>
                  <th className="pb-2 pr-4 text-right font-medium">Ever paid</th>
                  <th className="pb-2 text-right font-medium">Paid twice+</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => (
                  <tr
                    key={r.route}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                  >
                    <td className="py-2 pr-4">
                      <span className="font-medium">{ROUTE_LABEL[r.route] ?? r.route}</span>
                      <InfoTip label={`About ${ROUTE_LABEL[r.route] ?? r.route}`} width="26rem">
                        {ROUTE_NOTE[r.route]}
                      </InfoTip>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatNum(r.customers)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-neutral-500">
                      {formatNum(r.matured)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatNum(r.everPaid)}
                      <span className="ml-1.5 text-xs text-neutral-500">
                        {pct(r.conversionRate)}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                      {formatNum(r.repeatBuyers)}
                      <span className="ml-1.5 text-xs text-neutral-500">
                        {pct(r.repeatRate)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="First purchases vs repeat purchases, month by month"
          info="A single lifetime figure cannot tell 'repeat buying is growing' from 'we acquired a lot of people a year ago', and those call for opposite decisions."
        >
          <div className="space-y-1.5">
            {monthly.map((m) => {
              const total = m.firstPurchases + m.repeatPurchases;
              const firstPct = total > 0 ? (m.firstPurchases / total) * 100 : 0;
              return (
                <div key={m.month} className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-neutral-500">{m.month}</span>
                  <div
                    className="flex h-3 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800"
                    style={{ width: `${Math.max((total / maxMonth) * 100, 2)}%` }}
                  >
                    <div
                      className="h-full bg-neutral-400 dark:bg-neutral-600"
                      style={{ width: `${firstPct}%` }}
                      title={`${m.firstPurchases} first purchases`}
                    />
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${100 - firstPct}%` }}
                      title={`${m.repeatPurchases} repeat purchases`}
                    />
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                    {formatNum(m.firstPurchases)} first · {formatNum(m.repeatPurchases)} repeat
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-neutral-400 align-middle dark:bg-neutral-600" />
            first paid purchase
            <span className="ml-3 mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500 align-middle" />
            repeat purchase · bar width is total paid purchases that month
          </p>
        </Card>

        <p className="text-xs text-neutral-500">
          Lifetime value and cohort retention are on{" "}
          <Link href="/customers" className="underline decoration-dotted underline-offset-2">
            Customers &amp; LTV
          </Link>
          ; renewal behaviour by plan is on{" "}
          <Link href="/churn" className="underline decoration-dotted underline-offset-2">
            Churn &amp; cohorts
          </Link>
          .
        </p>
      </main>
    </div>
  );
}

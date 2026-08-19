/**
 * Scheduled renewals from the existing subscriber book.
 *
 * Server Component. Leads with the concentration rather than the total, because on this book
 * the concentration IS the story: essentially every subscription renews in one month, so the
 * annual figure is really a single-event figure and reads very differently once you know that.
 */

import { Card, Caveat, Stat, formatNum, formatUsd } from "../_components/ui";
import type { RenewalForecast } from "@/metrics/renewal-forecast";

export function RenewalPanel({ forecast: f }: { forecast: RenewalForecast }) {
  if (f.months.length === 0) {
    return (
      <Card title="Scheduled renewals" subtitle="Nothing billing in the next 12 months.">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No active subscription carries a future billing date. If that looks wrong, the Skio
          sync may not have run — check the freshness note on a marketing page.
        </p>
      </Card>
    );
  }

  const peak = f.concentration;

  return (
    <Card
      title="Scheduled renewals"
      subtitle="What the existing book is set to bill, from Skio's next-billing dates."
      info={
        <>
          <strong>Charges come from plan list prices, not from MRR.</strong> Deriving them from
          monthly-normalised MRR understated the annual book 3.8x — $26.28/yr against a real
          $100/yr across 865 subscriptions — because that plan bills yearly but delivers
          quarterly, and Skio queues a $0 order for each delivery. Prices are now written down
          in <code className="font-mono">metrics/plan-prices.ts</code>; anything without a known
          price falls back to arithmetic and is counted below.
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Next 12 months"
          value={formatUsd(f.totalExpectedCents, { compact: true })}
          hint={`${formatNum(f.totalSubscriptions)} subscriptions scheduled`}
          emphasis
        />
        <Stat
          label="Biggest month"
          value={peak ? formatUsd(monthTotal(f, peak.month), { compact: true }) : "—"}
          hint={peak ? `${peak.month} · ${Math.round(peak.share * 100)}% of the year` : "—"}
          emphasis
        />
        <Stat
          label="Cadences"
          value={String(f.cadences.length)}
          hint={f.cadences
            .map((c) => `${formatNum(c.subscriptions)} every ${c.intervalCount}mo`)
            .join(" · ")}
        />
      </div>

      {f.derivedCount > 0 || f.unknownCount > 0 ? (
        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          {f.derivedCount > 0 ? (
            <>
              {formatNum(f.derivedCount)} subscription(s) priced by arithmetic (MRR x billing
              interval) rather than a known plan price.{" "}
            </>
          ) : null}
          {f.unknownCount > 0 ? (
            <>
              <strong>{formatNum(f.unknownCount)} have no usable price and are excluded from
              the total</strong>, so it is a floor.
            </>
          ) : null}
        </p>
      ) : null}

      {peak && peak.share > 0.5 ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>
            {Math.round(peak.share * 100)}% of the next twelve months&rsquo; renewal revenue
            bills in {peak.month}.
          </strong>{" "}
          The subscription cycle is pinned to the issue release calendar, so this is expected
          rather than a data error — but it means the annual figure above is really a
          single-event figure. One weak renewal month is the whole year, and the cash arrives in
          one lump rather than spread across it.
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="py-2 pr-3 font-medium">Month</th>
              <th className="py-2 pr-3 text-right font-medium">Subscriptions</th>
              <th className="py-2 pr-3 text-right font-medium">Expected charge</th>
              <th className="py-2 text-right font-medium">MRR sum</th>
            </tr>
          </thead>
          <tbody className="text-neutral-700 dark:text-neutral-300">
            {f.months.map((m) => (
              <tr key={m.month} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="py-1.5 pr-3">{m.month}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatNum(m.subscriptions)}
                </td>
                <td className="py-1.5 pr-3 text-right font-medium tabular-nums">
                  {formatUsd(m.expectedChargeCents)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-neutral-400">
                  {formatUsd(m.mrrSumCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {f.priceWarning ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>Check the plan prices before quoting the total.</strong> {f.priceWarning}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Caveat summary="This is scheduled billing, not forecast revenue">
          Every active subscription is assumed to renew at its next billing date for its current
          price. It applies no churn rate, no failed payments and no upgrades, so treat it as a
          ceiling on the existing book rather than a prediction. Churn by cohort is on
          Customers &rarr; Churn &amp; cohorts; combining the two is the actual forecast.
        </Caveat>

        <Caveat summary="Cancelled and paused subscriptions are excluded">
          Only <code className="font-mono">status = active</code> counts. A subscription
          cancelled today stops appearing here immediately, which is why this figure can fall
          without anything having been billed.
        </Caveat>
      </div>
    </Card>
  );
}

function monthTotal(f: RenewalForecast, month: string): number {
  return f.months.find((m) => m.month === month)?.expectedChargeCents ?? 0;
}

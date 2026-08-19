/**
 * Free-issue promo performance.
 *
 * Server Component. The layout leads with COST and puts the conversion rate behind a maturity
 * gate, because the cost is known the moment the issue ships while the rate needs a renewal
 * cycle to elapse. Presenting them side by side as equally solid would invite reading a
 * fourteen-day-old cohort's 0% as a result.
 */

import { Card, Caveat, Stat, formatNum, formatUsd } from "../_components/ui";
import type { PromoCohort, PromoCohortReport } from "@/metrics/promo-cohorts";
import { MIN_MATURED_TO_RATE } from "@/metrics/promo-cohorts";

const pct = (v: number | null, dp = 1) => (v == null ? "—" : `${(v * 100).toFixed(dp)}%`);
const money = (v: number | null) => (v == null ? "—" : formatUsd(v));

function CohortRow({ c }: { c: PromoCohort }) {
  const gradeable = c.firstRenewalRate !== null;

  return (
    <div className="border-t border-neutral-100 py-4 first:border-t-0 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-mono text-sm font-medium">{c.promo}</span>
          <span className="ml-2 text-xs text-neutral-400">
            {c.firstGifted} → {c.lastGifted}
          </span>
        </div>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {formatNum(c.customers)} customers · {money(c.costCents)} ·{" "}
          {money(c.costPerCustomerCents)} each
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-400">
            Reached a renewal
          </div>
          <div className="mt-0.5 text-sm tabular-nums">
            {formatNum(c.matured)} / {formatNum(c.customers)}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-400">
            Paid at 1st renewal
          </div>
          <div
            className={`mt-0.5 text-sm tabular-nums ${
              gradeable ? "font-medium" : "text-neutral-400"
            }`}
          >
            {gradeable ? (
              <>
                {pct(c.firstRenewalRate)}{" "}
                <span className="font-normal text-neutral-400">
                  ({formatNum(c.convertedFirst)})
                </span>
              </>
            ) : (
              "not yet measurable"
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-400">
            Survived 2nd
          </div>
          <div
            className={`mt-0.5 text-sm tabular-nums ${
              gradeable ? "" : "text-neutral-400"
            }`}
          >
            {c.secondRenewalRate === null ? (
              "—"
            ) : (
              <>
                {pct(c.secondRenewalRate)}{" "}
                <span className="text-neutral-400">({formatNum(c.convertedSecond)})</span>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-400">
            Cost per paying sub
          </div>
          <div
            className={`mt-0.5 text-sm tabular-nums ${
              c.costPerConvertedCents === null ? "text-neutral-400" : "font-medium"
            }`}
          >
            {c.costPerConvertedCents === null ? "not yet measurable" : money(c.costPerConvertedCents)}
          </div>
        </div>
      </div>

      {/* Churn without ever paying needs no renewal to have happened, so it is the one thing
          that CAN be said about a cohort too young to grade. */}
      <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        {formatNum(c.stillActive)} still active · {formatNum(c.cancelled)} cancelled ·{" "}
        <strong>{formatNum(c.churnedUnpaid)}</strong> left without ever paying (
        {pct(c.churnedUnpaidRate, 0)})
      </div>

      {c.caveat ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {c.caveat}
        </p>
      ) : null}
    </div>
  );
}

export function PromoCohortPanel({ report }: { report: PromoCohortReport }) {
  if (report.cohorts.length === 0) {
    return (
      <Card title="Free-issue promos" subtitle="No acquisition promo codes found.">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Codes are listed in <code className="font-mono">metrics/acquisition-promos.ts</code>.
          Nothing matched, which either means no free issues have shipped or a new code needs
          adding there.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Free-issue promos"
      subtitle="What each free-issue offer cost, and how many went on to pay."
      info={
        <>
          <strong>Cost is the free issue itself</strong> — product, shipping and other
          fulfilment on the $0 order, the same boundary the rest of the app uses. It excludes
          the ad spend that put the offer in front of someone, which is on Campaigns &amp;
          creatives. Adding the two is the full acquisition cost; this page deliberately
          doesn&rsquo;t do it silently.
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Free issues given"
          value={formatNum(report.totalCustomers)}
          hint={`across ${report.cohorts.length} promo code(s)`}
          emphasis
        />
        <Stat
          label="Total cost"
          value={formatUsd(report.totalCostCents, { compact: true })}
          hint="product, shipping and fulfilment"
          emphasis
        />
        <Stat
          label="Too young to grade"
          value={`${report.immatureCohorts} / ${report.cohorts.length}`}
          hint="no member has reached a renewal date"
        />
      </div>

      <div className="mt-4">
        {report.cohorts.map((c) => (
          <CohortRow key={c.promo} c={c} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Caveat summary="A rate is withheld until the cohort has actually been asked to pay">
          Conversion is measured only against customers whose renewal date has passed, on their
          own billing interval — quarterly subscribers after ~90 days, annual after 12 months.
          A cohort with none matured shows &ldquo;not yet measurable&rdquo; rather than 0%,
          because 0% there would be measuring elapsed time rather than the offer. Below{" "}
          {MIN_MATURED_TO_RATE} matured, a rate is withheld as noise.
        </Caveat>

        <Caveat summary="Cohorts of different ages are not comparable">
          Read flat, a fourteen-day-old cohort always looks worse than a five-month-old one.
          Compare the <em>reached a renewal</em> counts before comparing any two rates — and
          prefer &ldquo;left without ever paying&rdquo;, which needs no renewal to have
          happened and is therefore fair on every cohort regardless of age.
        </Caveat>

        <Caveat summary="Annual subscribers renew once, in November">
          Every annual renewal in this book falls in Nov 2026. An annual-heavy cohort will show
          almost nobody matured until then — they have not declined to pay, they have not been
          asked.
        </Caveat>
      </div>
    </Card>
  );
}

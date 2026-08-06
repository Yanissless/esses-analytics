import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { goals } from "@/db/schema";
import { requireUser } from "@/lib/auth/current-user";
import { GOAL_METRICS, isGoalMetric } from "@/metrics/forecast";
import {
  getGoalProgress,
  getLastMetricsDate,
  getMonthlyActuals,
} from "@/metrics/forecast.server";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { GoalForm } from "./forms";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
const x = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}×`);

/** Money metrics hold cents; count metrics hold a plain number. */
const fmt = (value: number, unit: "money" | "count") =>
  unit === "money" ? formatUsd(value) : formatNum(value);

export default async function ForecastPage() {
  const user = await requireUser();

  /*
   * "Today" is the last day daily_metrics actually holds, not the wall clock. Projecting
   * from a later date would treat unsynced days as zeros and tank every estimate — the
   * kind of error that looks like a business collapse rather than a stale sync.
   */
  const lastMetricsDate = await getLastMetricsDate();
  const asOf = lastMetricsDate ?? new Date().toISOString().slice(0, 10);
  const periodStart = `${asOf.slice(0, 7)}-01`;

  const [progress, monthly, goalRows] = await Promise.all([
    getGoalProgress(periodStart, asOf),
    getMonthlyActuals(asOf),
    db.select().from(goals).where(eq(goals.periodStart, periodStart)).orderBy(desc(goals.metric)),
  ]);

  const complete = monthly.filter((m) => m.isComplete);
  const best = complete.reduce<(typeof complete)[number] | null>(
    (b, m) => (b == null || m.revenueCents > b.revenueCents ? m : b),
    null,
  );
  const maxRevenue = Math.max(...monthly.map((m) => m.revenueCents), 1);
  const withTargets = progress.filter((p) => p.targetAmount != null);
  const releaseAhead = progress[0]?.releaseAhead ?? false;
  const releaseDate = progress[0]?.releaseDate ?? null;
  const elapsed = progress[0]?.daysElapsed ?? 0;
  const totalDays = progress[0]?.daysInPeriod ?? 30;

  const existing = goalRows
    .filter((g) => isGoalMetric(g.metric))
    .map((g) => ({
      metric: g.metric,
      displayValue:
        GOAL_METRICS[g.metric as keyof typeof GOAL_METRICS].unit === "money"
          ? (g.targetAmount / 100).toString()
          : g.targetAmount.toString(),
    }));

  const staleDays = lastMetricsDate
    ? Math.floor(
        (Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(lastMetricsDate)) /
          86_400_000,
      )
    : null;

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Forecast &amp; goals</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Where this month lands if the last two weeks repeat — with the range, not just a
            number · {periodStart} → day {elapsed} of {totalDays}
          </p>
        </div>

        {staleDays != null && staleDays > 1 ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>
              Data is {staleDays} day{staleDays === 1 ? "" : "s"} behind.
            </strong>{" "}
            Everything here is measured to <strong>{asOf}</strong>, the last day the metrics
            tables hold — not today. Projections use that as the end of the observed period, so
            they&rsquo;re honest but they exclude the most recent days entirely. Run{" "}
            <code className="font-mono">run.cmd sync</code> to catch up.
          </div>
        ) : null}

        {releaseAhead ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>An issue releases on {releaseDate}, inside the remaining days.</strong>{" "}
            Treat every projection below as a floor rather than an estimate. Releases are this
            business&rsquo;s largest revenue spikes, and a run rate learned from pre-release days
            has no way to anticipate one — the last two weeks are simply not representative of
            what&rsquo;s coming.
          </div>
        ) : null}

        {/* ---- goal cards ---- */}
        {withTargets.length === 0 ? (
          <Card
            title="No targets set for this month"
            subtitle="Projections still work without them — set a target to get pace and attainment alongside"
          >
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Use the form below. Targets are per month and per metric, and you can change them at
              any time; nothing is recomputed.
            </p>
          </Card>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {progress.map((p) => {
            const meta = GOAL_METRICS[p.metric];
            const onPace = p.pace != null && p.pace >= 1;
            const willHit = p.projectedAttainment != null && p.projectedAttainment >= 1;
            return (
              <Card key={p.metric} title={meta.label} subtitle={meta.hint}>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-2xl font-medium tabular-nums tracking-tight">
                      {fmt(p.actualAmount, p.unit)}
                    </span>
                    {p.targetAmount != null ? (
                      <span className="text-sm text-neutral-500 dark:text-neutral-400">
                        of {fmt(p.targetAmount, p.unit)} · {pct(p.attainment)}
                      </span>
                    ) : (
                      <span className="text-sm text-neutral-500 dark:text-neutral-400">
                        no target set
                      </span>
                    )}
                  </div>

                  {p.targetAmount != null ? (
                    <>
                      <div className="h-2 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                        <div
                          className={
                            willHit
                              ? "h-full bg-emerald-500"
                              : onPace
                                ? "h-full bg-amber-500"
                                : "h-full bg-red-500"
                          }
                          style={{
                            width: `${Math.min((p.attainment ?? 0) * 100, 100)}%`,
                          }}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge tone={onPace ? "emerald" : "amber"}>
                          pace {x(p.pace)}
                        </Badge>
                        <span className="text-neutral-500 dark:text-neutral-400">
                          {onPace ? "ahead of" : "behind"} where an even month would be by day{" "}
                          {p.daysElapsed}
                        </span>
                      </div>
                    </>
                  ) : null}

                  <div className="rounded-lg bg-neutral-100/70 p-3 text-xs dark:bg-neutral-800/60">
                    <div className="font-medium text-neutral-700 dark:text-neutral-200">
                      Projected {fmt(p.projection.pointCents, p.unit)}
                      {p.projection.daysRemaining > 0 ? (
                        <span className="font-normal text-neutral-500 dark:text-neutral-400">
                          {" "}
                          ({fmt(p.projection.lowCents, p.unit)} –{" "}
                          {fmt(p.projection.highCents, p.unit)})
                        </span>
                      ) : null}
                      {p.targetAmount != null && p.projection.daysRemaining > 0 ? (
                        <span className="font-normal text-neutral-500 dark:text-neutral-400">
                          {" "}
                          · {pct(p.projectedAttainment)} of target
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-neutral-500 dark:text-neutral-400">
                      {p.projection.method}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        {/* ---- monthly history ---- */}
        <Card
          title="Monthly actuals"
          subtitle="The current month is partial — it is marked, because plotting it beside complete months reads as a collapse"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Month</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                  <th className="pb-2 text-right font-medium">CM3</th>
                  <th className="pb-2 text-right font-medium">Orders</th>
                  <th className="pb-2 text-right font-medium">New customers</th>
                  <th className="pb-2 text-right font-medium">Ad spend</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {monthly.map((m) => (
                  <tr key={m.month}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium tabular-nums">{m.month}</span>
                        {!m.isComplete ? <Badge tone="amber">in progress</Badge> : null}
                        {best && m.month === best.month ? (
                          <Badge tone="emerald">best</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(m.revenueCents)}</td>
                    <td
                      className={`py-2 text-right tabular-nums ${
                        m.cm3Cents < 0 ? "text-red-600 dark:text-red-400" : ""
                      }`}
                    >
                      {formatUsd(m.cm3Cents)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatNum(m.orders)}</td>
                    <td className="py-2 text-right tabular-nums">{formatNum(m.newCustomers)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(m.adSpendCents)}</td>
                    <td className="w-32 py-2">
                      <div className="h-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                        <div
                          className={
                            m.isComplete
                              ? "h-full bg-neutral-400 dark:bg-neutral-500"
                              : "h-full bg-amber-400"
                          }
                          style={{ width: `${(m.revenueCents / maxRevenue) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            Revenue is net Shopify (paid, ex-VAT) plus Stripe. CM3 follows the paid-order
            boundary, which is what <code className="font-mono">daily_metrics</code> stores —
            the live boundary setting affects Profit and International, not this series.
          </p>
        </Card>

        {/* ---- goal setting ---- */}
        {user.role === "admin" ? (
          <Card
            title={`Targets for ${periodStart}`}
            subtitle="Money targets are entered in dollars. Leaving a field blank clears that target, which is different from setting it to zero."
          >
            <GoalForm periodStart={periodStart} existing={existing} />
          </Card>
        ) : (
          <p className="pb-4 text-xs text-neutral-500">
            Targets are set by an admin under Forecast &amp; goals.
          </p>
        )}
      </main>
    </div>
  );
}

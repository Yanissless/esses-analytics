import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { requireCapability } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/capabilities";
import {
  DEFAULT_BASELINE_SHARE,
  DEFAULT_RELEASE_DAY,
  DEFAULT_RELEASE_MONTHS,
  GOAL_METRIC_OPTIONS,
  MONEY_METRICS,
  parseGoalPlan,
  planMonths,
} from "@/metrics/goal-plan-input";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { clearGoals, saveGoals } from "./actions";

export const dynamic = "force-dynamic";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const FIELD =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm " +
  "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const LABEL = "block text-xs font-medium text-neutral-600 dark:text-neutral-400";

/**
 * Goal planner — model a year, then save it.
 *
 * ## The URL is the plan
 *
 * The form is a plain GET. Every input round-trips through search params and the preview is a
 * server render, so there is no client state at all: you can bookmark a scenario, open two in
 * separate tabs to compare, and paste one to someone else. A client-side calculator would be
 * smoother by a few hundred milliseconds and lose all of that.
 *
 * Saving is a separate POST, so nothing is written by exploring. That separation matters more
 * than it looks — these targets are what every badge in the app is measured against, and a
 * planner that saved as you typed would make "what if we aimed for 400k" silently become the
 * company's target.
 */
export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireCapability("revenue");
  const canSave = can(user.role, "settings");
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);

  const thisYear = new Date().getUTCFullYear();
  const parsed = parseGoalPlan({
    metric: one("metric") ?? "revenue",
    // No default target: an invented number would be indistinguishable from a real plan.
    annual: one("annual") ?? "",
    year: one("year") ?? String(thisYear),
    shape: one("shape") ?? "release",
    releases: one("releases") ?? DEFAULT_RELEASE_MONTHS.join(","),
    releaseDay: one("releaseDay") ?? String(DEFAULT_RELEASE_DAY),
    baseline: one("baseline") ?? String(DEFAULT_BASELINE_SHARE * 100),
  });

  const year = Number(one("year") ?? thisYear);
  const metric = one("metric") ?? "revenue";
  const isMoney = MONEY_METRICS.has(metric);
  const plan = parsed.ok ? planMonths(parsed.plan) : null;

  // What is currently saved, so the page shows the plan of record next to the draft.
  const savedRows = await db.execute<{ period_start: string; target_amount: number }>(sql`
    SELECT period_start::text, target_amount FROM goals
     WHERE metric = ${metric}
       AND period_start >= ${`${year}-01-01`} AND period_start <= ${`${year}-12-01`}
     ORDER BY period_start
  `);
  const saved = new Map([...savedRows].map((r) => [r.period_start, Number(r.target_amount)]));

  const fmt = (v: number) => (isMoney ? formatUsd(v) : formatNum(v));

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          {/* This page is no longer in the nav — it is reached from the targets card on
              /forecast, so it needs a way back. A page with no route out is a dead end even
              when the back button works, because it gives no clue where it sits. */}
          <Link
            href="/forecast"
            className="text-xs text-neutral-500 underline decoration-dotted underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            ← Forecast &amp; goals
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Goal planner</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Model a year and see the monthly shape before committing to it. Nothing is saved
            until you press save.
          </p>
        </div>

        {/* GET, so the plan lives in the URL and can be shared or compared in two tabs. */}
        <Card title="Plan" subtitle="Change anything and the preview updates.">
          <form method="GET" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={LABEL} htmlFor="metric">Metric</label>
              <select id="metric" name="metric" defaultValue={metric} className={`${FIELD} mt-1`}>
                {GOAL_METRIC_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="annual">
                Annual target {isMoney ? "(dollars)" : "(count)"}
              </label>
              <input
                id="annual"
                name="annual"
                inputMode="decimal"
                placeholder={isMoney ? "250,000" : "14,000"}
                defaultValue={one("annual") ?? ""}
                className={`${FIELD} mt-1`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="year">Year</label>
              <input id="year" name="year" inputMode="numeric" defaultValue={String(year)} className={`${FIELD} mt-1`} />
            </div>
            <div>
              <label className={LABEL} htmlFor="shape">Shape</label>
              <select id="shape" name="shape" defaultValue={one("shape") ?? "release"} className={`${FIELD} mt-1`}>
                <option value="release">By issue release</option>
                <option value="flat">Even twelfths</option>
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="releases">Release months (1-12)</label>
              <input
                id="releases"
                name="releases"
                defaultValue={one("releases") ?? DEFAULT_RELEASE_MONTHS.join(",")}
                className={`${FIELD} mt-1`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="releaseDay">Release day of month</label>
              <input id="releaseDay" name="releaseDay" inputMode="numeric" defaultValue={one("releaseDay") ?? String(DEFAULT_RELEASE_DAY)} className={`${FIELD} mt-1`} />
            </div>
            <div>
              <label className={LABEL} htmlFor="baseline">Baseline share (%)</label>
              <input id="baseline" name="baseline" inputMode="numeric" defaultValue={one("baseline") ?? String(DEFAULT_BASELINE_SHARE * 100)} className={`${FIELD} mt-1`} />
              <p className="mt-1 text-[11px] text-neutral-400">
                Renewals and back issues that arrive whether or not an issue ships.
              </p>
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                Update preview
              </button>
            </div>
          </form>
        </Card>

        {!parsed.ok ? (
          <Card title="Nothing to preview yet" subtitle={parsed.error}>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Enter an annual target above. There is deliberately no default — an invented
              number here would be indistinguishable from a plan someone actually chose.
            </p>
          </Card>
        ) : plan ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Annual target"
                value={fmt(plan.annualStored)}
                hint={`${metric} · ${year}`}
                emphasis
              />
              <Stat
                label="Biggest month"
                value={fmt(Math.max(...plan.months.map((m) => m.target)))}
                hint={
                  MONTH_NAMES[
                    plan.months.indexOf(
                      plan.months.reduce((a, b) => (b.target > a.target ? b : a)),
                    )
                  ]
                }
              />
              <Stat
                label="Quietest month"
                value={fmt(Math.min(...plan.months.map((m) => m.target)))}
                hint={
                  MONTH_NAMES[
                    plan.months.indexOf(
                      plan.months.reduce((a, b) => (b.target < a.target ? b : a)),
                    )
                  ]
                }
              />
            </div>

            <Card title="Monthly split" subtitle={plan.weights.reason}>
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Month</th>
                    <th className="py-2 pr-3 text-right font-medium">Target</th>
                    <th className="py-2 pr-3 text-right font-medium">Share</th>
                    <th className="py-2 pr-3 text-right font-medium">Currently saved</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="text-neutral-700 dark:text-neutral-300">
                  {plan.months.map((m, i) => {
                    const current = saved.get(m.periodStart) ?? null;
                    const changed = current !== null && current !== m.target;
                    return (
                      <tr key={m.periodStart} className="border-t border-neutral-100 dark:border-neutral-800">
                        <td className="py-1.5 pr-3">{MONTH_NAMES[i]} {year}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(m.target)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-400">
                          {((m.target / plan.annualStored) * 100).toFixed(1)}%
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-500">
                          {current === null ? "—" : fmt(current)}
                        </td>
                        <td className="py-1.5">
                          {current === null ? (
                            <span className="text-xs text-neutral-400">new</span>
                          ) : changed ? (
                            <Badge tone="amber">changes</Badge>
                          ) : (
                            <span className="text-xs text-neutral-400">same</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-neutral-200 font-medium dark:border-neutral-700">
                    <td className="py-2 pr-3">Total</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {fmt(plan.months.reduce((a, m) => a + m.target, 0))}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">100%</td>
                    <td className="py-2 pr-3" />
                    <td className="py-2" />
                  </tr>
                </tbody>
              </table>
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                The twelve months sum exactly to the annual figure — the rounding remainder is
                placed on the largest month rather than left to drift, so a year&rsquo;s targets
                always reconcile against the year&rsquo;s target.
              </p>
            </Card>

            {canSave ? (
              <Card title="Save this plan" subtitle="Overwrites any existing targets for this metric and year.">
                <div className="flex flex-wrap items-center gap-3">
                  <form action={saveGoals}>
                    {/* The inputs are resubmitted, not the computed months: the action
                        recomputes from them, so the preview and the save can't disagree. */}
                    <input type="hidden" name="metric" value={metric} />
                    <input type="hidden" name="annual" value={one("annual") ?? ""} />
                    <input type="hidden" name="year" value={String(year)} />
                    <input type="hidden" name="shape" value={one("shape") ?? "release"} />
                    <input type="hidden" name="releases" value={one("releases") ?? DEFAULT_RELEASE_MONTHS.join(",")} />
                    <input type="hidden" name="releaseDay" value={one("releaseDay") ?? String(DEFAULT_RELEASE_DAY)} />
                    <input type="hidden" name="baseline" value={one("baseline") ?? String(DEFAULT_BASELINE_SHARE * 100)} />
                    <button
                      type="submit"
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      Save {plan.months.length} monthly targets
                    </button>
                  </form>
                  {saved.size > 0 ? (
                    <form action={clearGoals}>
                      <input type="hidden" name="metric" value={metric} />
                      <input type="hidden" name="year" value={String(year)} />
                      <button
                        type="submit"
                        className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        Clear {metric} {year}
                      </button>
                    </form>
                  ) : null}
                </div>
                <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                  Saved targets drive the ahead/behind badges on Forecast &amp; goals. Metrics
                  with no target show no badge at all rather than a misleading zero.
                </p>
              </Card>
            ) : (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                You can model plans here but not save them — saving needs the settings
                capability.
              </p>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}

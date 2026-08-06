import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import {
  getChurnCohorts,
  getIssueWindows,
  getPlanCadences,
  getRenewalCycleChurn,
  type ChurnDimension,
} from "@/metrics/churn";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (v: number | null) => (v == null ? "—" : formatUsd(v));
const mo = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}mo`);

const DIMENSIONS: Array<{ id: ChurnDimension; label: string; blurb: string }> = [
  {
    id: "issue_at_signup",
    label: "Issue at signup",
    blurb: "which issue was on sale when they subscribed — covers every subscription",
  },
  {
    id: "promo",
    label: "Promo code",
    blurb:
      "the marketing code on their first paid order; save-offer and goodwill codes are excluded",
  },
  { id: "plan", label: "Plan", blurb: "the cadence they chose" },
  { id: "channel", label: "Channel", blurb: "the marketing channel that acquired them" },
  { id: "signup_month", label: "Signup month", blurb: "calendar cohort" },
  {
    id: "issue_purchased",
    label: "Issue purchased",
    blurb: "the issue actually on the acquiring order — precise, but sparse",
  },
];

function isDimension(v: string | undefined): v is ChurnDimension {
  return DIMENSIONS.some((d) => d.id === v);
}

export default async function ChurnPage({
  searchParams,
}: {
  searchParams: Promise<{ dim?: string; plan?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const dimension: ChurnDimension = isDimension(params.dim) ? params.dim : "issue_at_signup";

  const plans = await getPlanCadences();
  /*
   * Holding the plan constant matters for any dimension that correlates with time.
   * A renewal is 3 months on one plan and 12 on another, so two issue cohorts with
   * different plan mixes are being measured at different points in their lifecycle —
   * and the mixes here are wildly different (Issue 04 is 57% annual, Issue 05 is 30%).
   * The blended view is still the default because it's the whole business; this filter
   * is how you check whether a gap is real or just cadence.
   */
  const selectedPlan = plans.find(
    (p) => `${p.planName}|${p.cycleMonths}` === params.plan && p.subscriptions >= 25,
  );

  const [cohorts, issues] = await Promise.all([
    getChurnCohorts(dimension, {
      minSubscriptions: 5,
      planName: selectedPlan?.planName,
      cycleMonths: selectedPlan?.cycleMonths ?? undefined,
    }),
    getIssueWindows(),
  ]);
  const planChoices = plans.filter((p) => p.subscriptions >= 25 && p.cycleMonths);

  // Renewal-cycle churn is computed per plan, because a "first renewal" is 3 months
  // for one plan and 12 for another — blending them produces a meaningless average.
  const bigPlans = planChoices;
  const perPlanCycles = await Promise.all(
    bigPlans.map(async (p) => ({
      plan: p,
      // Cadence as well as name: one plan name can cover two cadences, and
      // filtering on name alone would blend them back together.
      cycles: await getRenewalCycleChurn({
        planName: p.planName,
        cycleMonths: p.cycleMonths ?? undefined,
      }),
    })),
  );

  const totalSubs = cohorts.reduce((s, c) => s + c.subscriptions, 0);
  const untestedPlans = perPlanCycles.filter((p) => p.cycles.length === 0);
  const testedPlans = perPlanCycles.filter((p) => p.cycles.length > 0);
  const untestedSubs = untestedPlans.reduce((s, p) => s + p.plan.subscriptions, 0);
  const allPlanSubs = plans.reduce((s, p) => s + p.subscriptions, 0);

  const worst = cohorts
    .filter((c) => c.churnByFirstRenewalPct != null && c.matureSubscriptions >= 30)
    .sort((a, b) => (b.churnByFirstRenewalPct ?? 0) - (a.churnByFirstRenewalPct ?? 0))[0];
  const best = cohorts
    .filter((c) => c.churnByFirstRenewalPct != null && c.matureSubscriptions >= 30)
    .sort((a, b) => (a.churnByFirstRenewalPct ?? 1) - (b.churnByFirstRenewalPct ?? 1))[0];

  const href = (d: ChurnDimension) =>
    `/churn?dim=${d}${params.plan ? `&plan=${encodeURIComponent(params.plan)}` : ""}`;
  const planHref = (key: string | null) =>
    `/churn?dim=${dimension}${key ? `&plan=${encodeURIComponent(key)}` : ""}`;
  const active = DIMENSIONS.find((d) => d.id === dimension);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Churn &amp; cohorts</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Which issues, promos and channels bring subscribers who actually stay — measured at the
            renewal, not on raw cancellation counts.
          </p>
        </div>

        {/* The single most important caveat on this page. */}
        {untestedSubs > 0 ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>
              {formatNum(untestedSubs)} of {formatNum(allPlanSubs)} subscriptions have never faced a
              renewal yet.
            </strong>{" "}
            {untestedPlans
              .map((p) => `${p.plan.planName} (bills every ${p.plan.cycleMonths} months)`)
              .join(", ")}{" "}
            — the data only starts in October 2025, so not one subscription on{" "}
            {untestedPlans.length > 1 ? "those plans" : "that plan"} has reached its first rebill.
            Their churn to date
            reflects people cancelling <em>between</em> billings, not renewal behaviour. Every
            renewal-rate figure on this page therefore describes the shorter-cycle plans only, and
            the largest part of the subscriber base is still an open question.
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Subscriptions in view"
            value={formatNum(totalSubs)}
            hint={`${cohorts.length} cohorts by ${active?.label.toLowerCase()}`}
            emphasis
          />
          <Stat
            label="Worst cohort at renewal"
            value={worst ? pct(worst.churnByFirstRenewalPct) : "—"}
            hint={worst ? `${worst.label} · ${formatNum(worst.matureSubscriptions)} mature` : "no mature cohort yet"}
          />
          <Stat
            label="Best cohort at renewal"
            value={best ? pct(best.churnByFirstRenewalPct) : "—"}
            hint={best ? `${best.label} · ${formatNum(best.matureSubscriptions)} mature` : "no mature cohort yet"}
          />
          <Stat
            label="Spread"
            value={
              worst && best && worst.churnByFirstRenewalPct != null && best.churnByFirstRenewalPct != null
                ? `${((worst.churnByFirstRenewalPct - best.churnByFirstRenewalPct) * 100).toFixed(0)}pp`
                : "—"
            }
            hint="gap between best and worst — the size of the opportunity"
          />
        </div>

        {/* ---- renewal-cycle churn, per plan ---- */}
        <Card
          title="Churn at each renewal"
          subtitle="A renewal is 3 months on one plan and 12 on another, so these are reported per plan. Rate is conditional: of those who reached the previous renewal, the share who did not reach this one."
        >
          {testedPlans.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No plan has reached a renewal within the loaded history yet.
            </p>
          ) : (
            <div className="space-y-5">
              {testedPlans.map(({ plan, cycles }) => (
                <div key={`${plan.source}-${plan.planName}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{plan.planName}</span>
                    <Badge tone="neutral">{plan.cycleMonths}-month billing</Badge>
                    <Badge tone={plan.source === "skio" ? "blue" : "neutral"}>{plan.source}</Badge>
                    <span className="text-xs text-neutral-500">
                      {formatNum(plan.subscriptions)} subscriptions
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                          <th className="pb-2 font-medium">Renewal</th>
                          <th className="pb-2 text-right font-medium">Reached it</th>
                          <th className="pb-2 text-right font-medium">Lost at it</th>
                          <th className="pb-2 text-right font-medium">Churn at renewal</th>
                          <th className="pb-2 text-right font-medium">Still alive</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                        {cycles.map((c) => (
                          <tr key={c.cycle}>
                            <td className="py-2">
                              #{c.cycle}
                              <span className="ml-2 text-xs text-neutral-500">
                                ~month {c.approxMonths?.toFixed(0)}
                              </span>
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {formatNum(c.reachedCycle)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {formatNum(c.churnedAtCycle)}
                            </td>
                            <td
                              className={`py-2 text-right font-medium tabular-nums ${
                                (c.churnRateAtCyclePct ?? 0) > 0.3
                                  ? "text-red-600 dark:text-red-400"
                                  : ""
                              }`}
                            >
                              {pct(c.churnRateAtCyclePct)}
                            </td>
                            <td className="py-2 text-right tabular-nums text-neutral-500">
                              {pct(c.survivingPct)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
          {untestedPlans.length > 0 ? (
            <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
              Not shown: {untestedPlans.map((p) => `${p.plan.planName} (${p.plan.cycleMonths}mo)`).join(", ")}{" "}
              — no subscription on {untestedPlans.length > 1 ? "these plans" : "this plan"} has
              reached its first renewal yet.
            </p>
          ) : null}
        </Card>

        {/* ---- cohort comparison ---- */}
        <Card
          title="Cohort comparison"
          subtitle="Compare cohorts on 'churn by first renewal', not raw churn. Raw churn punishes older cohorts purely for having existed longer."
        >
          <div className="mb-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-neutral-500">Group by</span>
              {DIMENSIONS.map((d) => (
                <Link
                  key={d.id}
                  href={href(d.id)}
                  title={d.blurb}
                  className={`rounded-lg px-2.5 py-1 text-xs transition ${
                    d.id === dimension
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  }`}
                >
                  {d.label}
                </Link>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-neutral-500">Plan</span>
              <Link
                href={planHref(null)}
                className={`rounded-lg px-2.5 py-1 text-xs transition ${
                  !selectedPlan
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                }`}
              >
                All plans
              </Link>
              {planChoices.map((p) => {
                const key = `${p.planName}|${p.cycleMonths}`;
                const on = selectedPlan
                  ? selectedPlan.planName === p.planName &&
                    selectedPlan.cycleMonths === p.cycleMonths
                  : false;
                return (
                  <Link
                    key={key}
                    href={planHref(key)}
                    className={`rounded-lg px-2.5 py-1 text-xs transition ${
                      on
                        ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                        : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                    }`}
                  >
                    {p.planName} · {p.cycleMonths}mo
                  </Link>
                );
              })}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {active?.blurb}.{" "}
              {selectedPlan ? (
                <>
                  Filtered to <strong>{selectedPlan.planName}</strong>, so every cohort below shares
                  a {selectedPlan.cycleMonths}-month renewal cycle and is measured at the same point
                  in its lifecycle.
                </>
              ) : (
                <>
                  Blended across plans. For issue and month cohorts,{" "}
                  <strong>check a single plan before trusting a gap</strong> — a renewal is 3 months
                  on one plan and 12 on another, and the plan mix varies a lot by cohort.
                </>
              )}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Cohort</th>
                  <th className="pb-2 text-right font-medium">Subs</th>
                  <th className="pb-2 text-right font-medium">
                    Churn by 1st renewal
                    <span className="ml-1 font-normal normal-case">(compare this)</span>
                  </th>
                  <th className="pb-2 text-right font-medium">Mature</th>
                  <th className="pb-2 text-right font-medium">Raw churn</th>
                  <th className="pb-2 text-right font-medium">Median life</th>
                  <th className="pb-2 text-right font-medium">LTV / sub</th>
                  <th className="pb-2 text-right font-medium">Avg discount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {cohorts.map((c) => {
                  const thin = c.matureSubscriptions > 0 && c.matureSubscriptions < 30;
                  return (
                    <tr key={c.key}>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{c.label}</span>
                          {c.matureSubscriptions === 0 ? (
                            <Badge tone="amber">too new to judge</Badge>
                          ) : thin ? (
                            <Badge tone="neutral">thin</Badge>
                          ) : null}
                        </div>
                        <div className="text-xs text-neutral-500">
                          {formatNum(c.customers)} customers · {formatNum(c.active)} active
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatNum(c.subscriptions)}</td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          c.churnByFirstRenewalPct == null
                            ? "text-neutral-400"
                            : c.churnByFirstRenewalPct > 0.4
                              ? "text-red-600 dark:text-red-400"
                              : c.churnByFirstRenewalPct < 0.2
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-600 dark:text-amber-400"
                        }`}
                      >
                        {pct(c.churnByFirstRenewalPct)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-neutral-500">
                        {formatNum(c.matureSubscriptions)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-neutral-500">
                        {pct(c.churnRatePct)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {mo(c.medianLifetimeMonths)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {money(c.ltvPerSubscriberCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-neutral-500">
                        {money(c.avgDiscountCents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            <strong>Mature</strong> is how many subscriptions in the cohort are old enough to have
            faced a first renewal — the denominator behind the churn figure beside it. A cohort with
            0 mature subscriptions cannot be judged yet at any confidence, and one under 30 is
            marked thin. Cohorts smaller than 5 subscriptions are hidden entirely.
          </p>
        </Card>

        {/* ---- derived issue windows, so the cohorting is auditable ---- */}
        {dimension === "issue_at_signup" || dimension === "issue_purchased" ? (
          <Card
            title="Issue release windows"
            subtitle="Derived from order history, not a published schedule — shown so the issue cohorts above can be checked"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                    <th className="pb-2 font-medium">Issue</th>
                    <th className="pb-2 font-medium">First non-preorder sale</th>
                    <th className="pb-2 font-medium">Superseded</th>
                    <th className="pb-2 text-right font-medium">Order lines</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {issues.map((i) => (
                    <tr key={i.issueNumber}>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            Issue {String(i.issueNumber).padStart(2, "0")}
                          </span>
                          {!i.releasedInWindow ? <Badge tone="neutral">back catalogue</Badge> : null}
                        </div>
                      </td>
                      <td className="py-2 tabular-nums">{i.releasedOn}</td>
                      <td className="py-2 tabular-nums text-neutral-500">
                        {i.supersededOn ?? "current"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatNum(i.ordersInWindow)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              Issues marked <strong>back catalogue</strong> were already on sale when the data window
              opened in October 2025, so their &ldquo;release&rdquo; date is an artefact of the
              backfill start rather than a fact. Signups before the first in-window release are
              grouped as &ldquo;or earlier&rdquo; instead of being assigned a spurious issue. Supply
              real on-sale dates and these become exact.
            </p>
          </Card>
        ) : null}
      </main>
    </div>
  );
}

import { requireUser } from "@/lib/auth/current-user";
import { getSourceFreshness, STALE_AFTER_HOURS } from "@/lib/freshness.server";
import { getRefreshState, STALE_AFTER_MINUTES, COOLDOWN_MINUTES } from "@/lib/sync/auto-refresh.server";
import {
  getRecentRuns,
  getReliability,
  MIN_RUNS_TO_RATE,
  RELIABILITY_WINDOW,
  STANDING_MIN_RUNS,
} from "@/lib/sync/sync-log.server";
import { Badge, Card, InfoTip, Stat, formatNum } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

/**
 * Where the data came from and whether the updating is actually working.
 *
 * Not gated on a capability: everyone reading a number needs to know how old it is, and gating
 * this would mean a viewer trusting a figure an admin could see was three days stale.
 */

const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);

/** Local time, second precision. These are timestamps you compare against a clock. */
function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-neutral-400">—</span>;
  // `partial` is deliberately amber and not green. It means the run completed and something was
  // wrong — the exact state that hid the Shopify cursor bug for two weeks.
  const tone =
    status === "success"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
      : status === "partial"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
        : status === "running"
          ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          : "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400";
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>
  );
}

export default async function DataPage() {
  const user = await requireUser();

  const [refresh, freshness, reliability, runs] = await Promise.all([
    getRefreshState(),
    getSourceFreshness(),
    getReliability(),
    getRecentRuns(60),
  ]);

  const decision = refresh.decision;
  const problems = reliability.filter((r) => r.failed > 0 || r.partial > 0);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Data updates</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            The app refreshes itself when you open it and the data is stale. This is the record of
            whether that worked.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Last completed sync"
            value={when(refresh.lastFinishedAt)}
            hint={refresh.inFlight ? "a sync is running now" : undefined}
            emphasis
          />
          <Stat
            label="Auto-refresh"
            value={
              refresh.inFlight ? "Running" : decision.refresh ? "Due" : "Holding"
            }
            hint={decision.reason}
          />
          <Stat
            label="Sources tracked"
            value={formatNum(freshness.length)}
            hint={`${problems.length} with recent trouble`}
          />
          <Stat
            label="Stale sources"
            value={formatNum(freshness.filter((f) => f.stale).length)}
            hint={`older than ${STALE_AFTER_HOURS}h`}
          />
        </div>

        <Card
          title="How the updating works"
          info={
            `Refreshes when the newest completed sync is over ${STALE_AFTER_MINUTES / 60}h old, ` +
            `and never more than once every ${COOLDOWN_MINUTES} minutes. The cooldown counts ` +
            `from the last attempt, not the last success — a broken source never becomes fresh, ` +
            `so without it a failing sync would retry on every page view and bill a third-party ` +
            `API each time.`
          }
        >
          <div className="space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
            <p>
              Opening any page starts a refresh if the data is stale. Nothing to click, and it
              never blocks the page — the figures on screen stay put and update in place when the
              sync finishes.
            </p>
            <p>
              <strong className="text-neutral-800 dark:text-neutral-200">
                It only runs while the app is open.
              </strong>{" "}
              That matters for Instagram specifically: Meta serves follower history over a rolling
              30 days and never publishes it again, so a week with the app closed is a week of
              follower history gone permanently. The nightly scheduled sync covers that once the
              app is deployed.
            </p>
          </div>
        </Card>

        <Card
          title="Per source"
          info={
            `Counted over the last ${RELIABILITY_WINDOW} runs of each source, and withheld below ` +
            `${MIN_RUNS_TO_RATE} runs because one failure in two is not a 50% rate. "Problems" ` +
            `means runs that failed or carried a warning that is NOT one of the standing gaps. ` +
            `A gap that recurs in ${STANDING_MIN_RUNS} or more runs is a known condition rather ` +
            `than an incident — Shopify was reading as 85% troubled off two of them repeating, ` +
            `which would have buried anything genuinely new.`
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 pr-4 font-medium">Source</th>
                  <th className="pb-2 pr-4 font-medium">Latest</th>
                  <th className="pb-2 pr-4 font-medium">Last completed</th>
                  <th className="pb-2 pr-4 font-medium">Newest data</th>
                  <th className="pb-2 pr-4 text-right font-medium">Recent runs</th>
                  <th className="pb-2 pr-4 text-right font-medium">Problems</th>
                  <th className="pb-2 pr-4 font-medium">Known gaps</th>
                  <th className="pb-2 text-right font-medium">Typical</th>
                </tr>
              </thead>
              <tbody>
                {reliability.map((r) => {
                  const f = freshness.find((x) => x.source === r.source);
                  return (
                    <tr
                      key={r.source}
                      className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                    >
                      <td className="py-2 pr-4 font-medium">{r.source}</td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={r.latestStatus} />
                      </td>
                      <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                        {when(f?.lastRunAt ?? null)}
                        {f?.stale ? (
                          <span className="ml-1.5 text-amber-600 dark:text-amber-400">stale</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                        {f?.lastDataDate ?? "—"}
                        {f?.lastDayProvisional ? (
                          <span className="ml-1.5 text-xs text-neutral-500">
                            provisional
                            <InfoTip label="Why this day is provisional">
                              Ad platforms restate recent days as late conversions land and
                              billing settles, so this day will change even though the sync just
                              ran. It is about the data&rsquo;s shape, not the sync&rsquo;s
                              recency.
                            </InfoTip>
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.runs}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.anomalies === 0 ? (
                          <span className="text-neutral-400">none</span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">
                            {r.anomalies}
                            {r.anomalyRate !== null ? (
                              <span className="ml-1 text-neutral-500">
                                ({Math.round(r.anomalyRate * 100)}%)
                              </span>
                            ) : (
                              <span className="ml-1 text-neutral-500">
                                <InfoTip label="Why no rate is shown">
                                  Fewer than {MIN_RUNS_TO_RATE} settled runs, so the count is
                                  shown without a rate. One failure in two is not a 50% failure
                                  rate, and printing it as one sends you chasing a problem a
                                  single transient network error explains.
                                </InfoTip>
                              </span>
                            )}
                            {/* The raw status count, so the softer headline is never the only
                                number available. Shopify's 15 partial runs are real; what the
                                Problems column says is that 14 of them were the same two known
                                gaps. */}
                            {r.partial + r.failed > r.anomalies ? (
                              <span className="ml-1.5 text-[11px] font-normal text-neutral-400">
                                of {r.partial + r.failed} flagged
                                <InfoTip label="Why these two numbers differ">
                                  {r.partial + r.failed} runs were recorded as failed or partial.
                                  {" "}
                                  {r.anomalies} of those are counted as problems; the rest carried
                                  only warnings that recur across the window, which makes them
                                  known gaps rather than incidents. Both numbers are here because
                                  the softer one should never be the only one on offer.
                                </InfoTip>
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        {r.newWarnings.length > 0 ? (
                          <span className="font-medium text-rose-600 dark:text-rose-400">
                            {r.newWarnings.length} new
                            <InfoTip label="Warnings new in the latest run" width="26rem">
                              <p className="mb-2">
                                In the latest run and not seen recurring — the actionable set.
                              </p>
                              <ul className="space-y-1">
                                {r.newWarnings.map((w, i) => (
                                  <li key={i} className="break-words">
                                    {w}
                                  </li>
                                ))}
                              </ul>
                            </InfoTip>
                          </span>
                        ) : r.standingWarnings.length > 0 ? (
                          <span className="text-neutral-500">
                            {r.standingWarnings.length} standing
                            <InfoTip label="Standing gaps for this source" width="26rem">
                              <p className="mb-2">
                                Recurring across the last {RELIABILITY_WINDOW} runs, so they are
                                known conditions rather than incidents. Still worth closing — they
                                are the reason some data is missing.
                              </p>
                              <ul className="space-y-1">
                                {r.standingWarnings.map((w, i) => (
                                  <li key={i} className="break-words">
                                    {w}
                                  </li>
                                ))}
                              </ul>
                            </InfoTip>
                          </span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                        {secs(r.medianMs)}
                      </td>
                    </tr>
                  );
                })}
                {reliability.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-sm text-neutral-500">
                      No syncs recorded yet. The first one is a full backfill and has to be started
                      deliberately — double-click UPDATE DATA.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>

        {freshness.some((f) => f.warnings.length > 0) ? (
          <Card
            title="Warnings on the latest run"
            info="The full text of every warning the most recent run of each source carried. A warning means the run completed but could not do everything it set out to — usually a missing permission, or an API field that is no longer served. Whether each one is a known gap or something new is the Known gaps column above; this is where the wording lives."
          >
            <div className="space-y-3">
              {freshness
                .filter((f) => f.warnings.length > 0)
                .map((f) => (
                  <div key={f.source} className="text-sm">
                    <div className="font-medium">{f.source}</div>
                    <ul className="mt-1 space-y-1 text-neutral-600 dark:text-neutral-400">
                      {f.warnings.map((w, i) => (
                        <li key={i} className="flex gap-2">
                          <span aria-hidden className="text-amber-500">
                            •
                          </span>
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          </Card>
        ) : null}

        <Card
          title="Recent runs"
          info="Every run, whatever its outcome — including the ones that completed with warnings. Filtering this to successes is what let the Shopify cursor sit frozen for two weeks while the source looked healthy."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 pr-4 font-medium">Started</th>
                  <th className="pb-2 pr-4 font-medium">Source</th>
                  <th className="pb-2 pr-4 font-medium">Mode</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 text-right font-medium">Took</th>
                  <th className="pb-2 pr-4 text-right font-medium">Rows in</th>
                  <th className="pb-2 text-right font-medium">Written</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                  >
                    <td className="py-2 pr-4 whitespace-nowrap text-neutral-600 dark:text-neutral-400">
                      {when(r.startedAt)}
                    </td>
                    <td className="py-2 pr-4 font-medium">{r.source}</td>
                    <td className="py-2 pr-4 text-neutral-500">{r.mode}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={r.status} />
                      {r.error ? (
                        <span className="ml-1.5">
                          <InfoTip label="Error from this run" width="26rem">
                            <span className="break-words">{r.error}</span>
                          </InfoTip>
                        </span>
                      ) : null}
                      {r.warnings.length > 0 ? (
                        <span className="ml-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                          {r.warnings.length}w
                          <InfoTip label="Warnings from this run" width="26rem">
                            <ul className="space-y-1">
                              {r.warnings.map((w, i) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          </InfoTip>
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                      {r.finishedAt === null && r.status === "running" ? (
                        <span className="text-neutral-400">running</span>
                      ) : r.finishedAt === null ? (
                        // Started, never finished, and not running: the process died without
                        // writing a finish. Worth showing as its own state rather than a dash.
                        <span className="text-rose-600 dark:text-rose-400">no finish</span>
                      ) : (
                        secs(r.durationMs)
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                      {formatNum(r.rowsIn)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                      {formatNum(r.rowsUpserted)}
                    </td>
                  </tr>
                ))}
                {runs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-4 text-sm text-neutral-500">
                      Nothing recorded yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            Newest 60 runs. <Badge>read-only</Badge> This page shows the log; it does not start a
            sync.
          </p>
        </Card>
      </main>
    </div>
  );
}

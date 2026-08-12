import { requireCapability } from "@/lib/auth/current-user";
import { getAudienceGrowth, MIN_POINTS_FOR_R } from "@/metrics/audience-growth";
import { Card, Stat, formatNum } from "../_components/ui";
import { Nav } from "../_components/nav";
import {
  AbsoluteSeriesChart,
  AudienceTable,
  IndexedGrowthChart,
  LagProfileChart,

} from "./charts";

export const dynamic = "force-dynamic";

const r2 = (v: number | null) => (v == null ? "—" : v.toFixed(2));
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);

/**
 * Audience — is the social following turning into subscribers?
 *
 * Gated on `marketing`, so all three roles reach it: this is acquisition performance,
 * and it carries no cost, margin or individual customer data.
 *
 * The page deliberately leads with the honest version of the headline. Correlating two
 * rising series is the easiest way to produce a confident wrong number, so the r on
 * weekly changes is the stat tile and the r on levels is shown beside it, labelled as
 * the one not to quote. Anyone can get 0.97 out of this data; the useful question is
 * what survives removing the shared trend.
 */
export default async function AudiencePage() {
  const user = await requireCapability("marketing");
  const growth = await getAudienceGrowth("instagram");

  const hasFollowerData = growth.points.some((p) => p.followers !== null);
  // Extracted here rather than passed as an accessor: props crossing into a Client
  // Component must be serializable, and a function is not — it fails at request time with
  // an error neither tsc nor build reports. See the note in charts.tsx.
  const weeks = growth.points.map((p) => p.weekStart);
  const measurable = growth.deltaCorrelation !== null;
  const best = growth.lag.best;

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Audience</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Instagram following against paying subscribers — whether the audience is
            converting, and whether one leads the other.
          </p>
        </div>

        {!hasFollowerData ? (
          <Card title="No follower data yet">
            <div className="space-y-3 text-sm text-neutral-600 dark:text-neutral-400">
              <p>
                Everything on this page is built and tested; it has no follower numbers to
                draw. Instagram follower counts need four Meta scopes that the token does
                not currently carry —{" "}
                <code className="font-mono text-xs">instagram_basic</code>,{" "}
                <code className="font-mono text-xs">instagram_manage_insights</code>,{" "}
                <code className="font-mono text-xs">pages_show_list</code> and{" "}
                <code className="font-mono text-xs">pages_read_engagement</code> — and the
                app can currently see 0 Pages. Run{" "}
                <code className="font-mono text-xs">run.cmd check:meta</code> for the
                current state.
              </p>
              <p>
                <strong className="text-neutral-800 dark:text-neutral-200">
                  Granting the scopes will not backfill history.
                </strong>{" "}
                Instagram&apos;s follower-count insight only returns a rolling ~30-day
                window, so the past can only come from numbers you already have. Import
                them and this page fills in immediately:
              </p>
              <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs dark:bg-neutral-900">
                {`run.cmd import:social --file="followers.csv"
run.cmd import:social --platform=instagram --date=2026-08-11 --followers=18240`}
              </pre>
              <p>
                CSV wants a header row of{" "}
                <code className="font-mono text-xs">date,platform,followers</code> —{" "}
                <code className="font-mono text-xs">following</code>,{" "}
                <code className="font-mono text-xs">posts</code> and{" "}
                <code className="font-mono text-xs">note</code> are optional. Weekly
                readings are plenty; {MIN_POINTS_FOR_R} weeks is the point at which a
                correlation starts to mean anything.
              </p>
            </div>
          </Card>
        ) : (
          <>
            {/* Totals first — the plain "how big are we" question, before any ratio or
                correlation. Both read from the last week with a real follower reading, so
                they are the same week as each other. */}
            <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3">
              <Stat
                label="Total followers"
                value={growth.latest.followers === null ? "—" : formatNum(growth.latest.followers)}
                hint={
                  growth.latest.weekStart
                    ? `Instagram, week of ${growth.latest.weekStart}`
                    : undefined
                }
                emphasis
              />
              <Stat
                label="Total subscribers"
                value={
                  growth.latest.subscribers === null ? "—" : formatNum(growth.latest.subscribers)
                }
                hint="active, Skio + Stripe, same week"
                emphasis
              />
              <Stat
                label="Followers per subscriber"
                value={
                  growth.latest.followersPerSubscriber === null
                    ? "—"
                    : growth.latest.followersPerSubscriber.toFixed(1)
                }
                hint="falling is good — subscribers growing faster than the following"
              />
            </div>

            <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat
                label="Follower growth / week"
                value={pct(growth.followerGrowthRate)}
                hint="compound, across the observed window"
              />
              <Stat
                label="Subscriber growth / week"
                value={pct(growth.subscriberGrowthRate)}
                hint="compound, same window"
              />
              <Stat
                label="Correlation (weekly change)"
                value={r2(growth.deltaCorrelation)}
                hint={
                  measurable
                    ? "the figure to quote — shared trend removed"
                    : `not measurable — needs ${MIN_POINTS_FOR_R} paired weeks, have ${growth.pairedWeeks}`
                }
              />
              <Stat
                label="Best lead time"
                value={best ? `${best.lag}w` : "—"}
                hint={
                  best
                    ? `r ${best.r?.toFixed(2)} — follower change leading subscriber change`
                    : "not measurable yet"
                }
              />
            </div>

            {/* Absolute totals as small multiples — each on its own axis. Deliberately
                NOT one chart with two y-scales: see the note under the pair. */}
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <Card title="Total followers" subtitle="Instagram, weekly. Own axis.">
                <AbsoluteSeriesChart
                  weeks={weeks}
                  values={growth.points.map((p) => p.followers)}
                  series="follower"
                  label="followers"
                />
              </Card>
              <Card title="Total subscribers" subtitle="Active, Skio + Stripe, weekly. Own axis.">
                <AbsoluteSeriesChart
                  weeks={weeks}
                  values={growth.points.map((p) => p.subscribers)}
                  series="subscriber"
                  label="subscribers"
                />
              </Card>
            </div>

            <Card
              title="Followers per subscriber"
              subtitle="The two totals as one series — falling means subscribers are outpacing the following."
              className="mb-4"
            >
              <AbsoluteSeriesChart
                weeks={weeks}
                values={growth.points.map((p) => p.followersPerSubscriber)}
                series="follower"
                label="followers per subscriber"
                precision={1}
              />
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                Why the two totals aren&apos;t drawn on one chart: at roughly{" "}
                {growth.latest.followers && growth.latest.subscribers
                  ? `${formatNum(growth.latest.followers)} against ${formatNum(growth.latest.subscribers)}`
                  : "18,000 against 2,000"}{" "}
                they are an order of magnitude apart, so sharing a chart would mean two
                y-axes — and then where the lines cross and how far apart they sit follow
                from where those axes were placed rather than from the business. Two charts
                above give you each real number on its own scale; this ratio gives you the
                comparison as a single series that can&apos;t be distorted that way.
              </p>
            </Card>

            <Card
              title="Growth, indexed to a common base"
              subtitle="Both series = 100 at the first observed week. One axis on purpose — see the note below."
            >
              <IndexedGrowthChart points={growth.indexed} />
              <AudienceTable points={growth.indexed} />
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                Indexed rather than plotted on two y-axes. With a dual axis, where the
                lines cross and how far apart they sit follow from where the two scales
                were placed, not from the data — slide one and the story changes. Indexed,
                the steeper line is genuinely growing faster.
              </p>
            </Card>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Card
                title="Does follower growth arrive first?"
                subtitle="Correlation of weekly follower change against subscriber change, at each lag."
              >
                <LagProfileChart profile={growth.lag.profile} />
                <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                  {best && best.lag > 0
                    ? `Strongest at ${best.lag} week(s), which would make follower growth a leading indicator worth watching weekly.`
                    : best
                      ? "Strongest at lag 0 — the two move in the same week, so followers look like a by-product of whatever drives subscriptions rather than a cause of them."
                      : "Every lag costs a paired observation, so this needs more weeks of follower data than a plain correlation does."}
                </p>
              </Card>

              <Card
                title="The number not to quote"
                subtitle="Why the impressive correlation is the useless one."
              >
                <div className="space-y-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-2xl font-semibold tabular-nums text-neutral-400">
                      {r2(growth.levelCorrelation)}
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      r on the raw levels
                    </span>
                  </div>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Followers and subscribers both trend upward, so this is near 1.0
                    whether or not there is any relationship at all. It measures the
                    passage of time. The stat tile above uses weekly{" "}
                    <em>changes</em>, which removes the shared trend — that is the figure
                    with information in it.
                  </p>
                  {growth.followersPerNetSubscriber !== null && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      Over the window: {formatNum(Math.round(growth.followersPerNetSubscriber))}{" "}
                      net new followers per net new subscriber. A ratio of two totals, not
                      a cost or a conversion rate.
                    </p>
                  )}
                </div>
              </Card>
            </div>
          </>
        )}

        <Card title="What this page cannot tell you" className="mt-4">
          <ul className="space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            {growth.caveats.map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden className="text-neutral-400">
                  •
                </span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </div>
  );
}

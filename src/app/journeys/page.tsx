import { requireCapability } from "@/lib/auth/current-user";
import { getAttributionCoverage } from "@/attribution/report";
import { getTimeToConversion, getTouchDistribution } from "@/attribution/journeys";
import { Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { resolvePageRange } from "@/lib/date-range.server";
import { Nav } from "../_components/nav";
import { DateRangePicker } from "../_components/date-range-picker";

export const dynamic = "force-dynamic";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function hoursLabel(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return "<1h";
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Horizontal bar with the value printed on it — no hover needed to read a 4-row table. */
function Bar({
  label,
  value,
  share,
  peak,
  sub,
  muted = false,
}: {
  label: string;
  value: string;
  share: number;
  peak: number;
  sub?: string;
  muted?: boolean;
}) {
  const width = peak > 0 ? Math.max((share / peak) * 100, 1.5) : 1.5;
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
        <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
          {value} · {pct(share)}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div
          className="h-2 rounded-full"
          style={{
            width: `${width}%`,
            // Muted for the unattributable bucket: it is the biggest bar on the page and
            // colouring it like a result would read as an achievement.
            background: muted ? "#a3a3a3" : "#2a78d6",
          }}
        />
      </div>
      {sub && <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">{sub}</p>}
    </div>
  );
}

/**
 * Journeys — what attribution can and cannot see.
 *
 * This is deliberately a coverage page rather than a path explorer. 71% of countable orders
 * have no non-internal touchpoint, 23% have exactly one, and roughly 5.6% have a multi-touch
 * journey — so top-converting-paths and assist-versus-close would render a few hundred
 * orders in an interface implying they described the business. The decision this page
 * actually supports is whether attribution deserves more investment, and the answer is
 * visible in the first two numbers.
 *
 * Gated on `marketing`: acquisition performance, no cost or margin, no individual records.
 */
export default async function JourneysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireCapability("marketing");
  // Range from the URL, anchored to the last day with DATA — see lib/date-range.ts.
  const { range, compareMode, comparison, bounds } = await resolvePageRange(await searchParams);
  const since = range.since;
  const until = range.until;

  const [coverage, distribution, latency] = await Promise.all([
    getAttributionCoverage(since, until),
    getTouchDistribution(since, until),
    getTimeToConversion(since, until),
  ]);

  const peakOrders = Math.max(...distribution.map((d) => d.shareOfOrders), 0.01);
  const peakLatency = Math.max(...latency.buckets.map((b) => b.shareOfJourneys), 0.01);
  const multiTouch = distribution
    .filter((d) => d.bucket === "2-3" || d.bucket === "4+")
    .reduce((a, d) => a + d.orders, 0);
  const multiShare = coverage.ordersTotal > 0 ? multiTouch / coverage.ordersTotal : 0;
  const zero = distribution.find((d) => d.bucket === "0");

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          {/* Titled to match the nav, and to match what the page is. "Journeys" promised a
              path explorer this deliberately isn't — 71% of countable orders have no
              non-internal touchpoint at all, so the honest subject is coverage. */}
          <h1 className="text-2xl font-semibold tracking-tight">Attribution coverage</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            What attribution can and cannot see · {range.label}
          </p>
        </div>

        <div className="mb-4">
          <DateRangePicker
            preset={range.preset}
            compareMode={compareMode}
            since={range.since}
            until={range.until}
            anchor={bounds.anchor}
            dataStart={bounds.start}
            lagDays={bounds.lagDays}
            comparisonUnavailable={comparison === null}
          />
        </div>

        <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat
            label="Orders with any journey"
            value={pct(
              coverage.ordersTotal > 0 ? coverage.ordersWithTouchpoints / coverage.ordersTotal : 0,
            )}
            hint={`${formatNum(coverage.ordersWithTouchpoints)} of ${formatNum(coverage.ordersTotal)} countable orders`}
            emphasis
          />
          <Stat
            label="Coverage of addressable"
            value={pct(coverage.coverageOfAddressablePct)}
            hint="the fair number — excludes orders that never had a session"
            emphasis
          />
          <Stat
            label="Multi-touch journeys"
            value={pct(multiShare)}
            hint={`${formatNum(multiTouch)} orders with 2+ touches`}
          />
          <Stat
            label="Median time to order"
            value={hoursLabel(latency.medianHours)}
            hint={`first touch → order · p90 ${hoursLabel(latency.p90Hours)}`}
          />
        </div>

        <Card
          title="Touches per order"
          subtitle="Every countable order in the window, by how many non-internal touchpoints it has."
        >
          {distribution.map((d) => (
            <Bar
              key={d.bucket}
              label={
                d.bucket === "0"
                  ? "0 — unattributable"
                  : d.bucket === "1"
                    ? "1 — single session"
                    : `${d.bucket} touches`
              }
              value={`${formatNum(d.orders)} orders · ${formatUsd(d.revenueCents, { compact: true })}`}
              share={d.shareOfOrders}
              peak={peakOrders}
              muted={d.bucket === "0"}
              sub={
                d.bucket === "0" && d.noSessionPossible > 0
                  ? `${formatNum(d.noSessionPossible)} of these could never have had a journey — API-created subscription renewals and comps, where no human browsed. That part is not a tracking gap and no amount of tagging fixes it.`
                  : undefined
              }
            />
          ))}
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            The average path length is {coverage.avgPathLength}, which reads like a typical
            journey has one-and-a-bit touches. The distribution says something different and
            more useful: the mode is {zero && zero.shareOfOrders > 0.5 ? "zero" : "one"}, and
            multi-touch journeys are {pct(multiShare)} of orders. Where a journey is a single
            session, all four attribution models credit the same channel by construction — so
            choosing between last-non-direct, linear, time-decay and first-touch only changes
            the answer for that {pct(multiShare)}.
          </p>
        </Card>

        <Card
          title="Time from first touch to order"
          subtitle={`The ${formatNum(latency.journeys)} orders that have at least one touchpoint.`}
          className="mt-4"
        >
          {latency.journeys === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              No journeys in this window.
            </p>
          ) : (
            latency.buckets.map((b) => (
              <Bar
                key={b.bucket}
                label={b.bucket}
                value={`${formatNum(b.orders)} orders`}
                share={b.shareOfJourneys}
                peak={peakLatency}
              />
            ))
          )}
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            This is the one journey question the single-session majority can still answer, and
            it is the number to check before shortening or lengthening a campaign window. A
            touchpoint stamped marginally after its order is treated as same-day rather than
            dropped — that is clock skew between our session capture and Shopify&apos;s
            processed timestamp, and discarding those rows would bias the distribution toward
            longer journeys.
          </p>
        </Card>

        <Card title="What would actually improve this" className="mt-4">
          <ul className="space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <li className="flex gap-2">
              <span aria-hidden className="text-neutral-400">•</span>
              <span>
                <strong className="text-neutral-800 dark:text-neutral-200">
                  UTM tagging on ad destinations.
                </strong>{" "}
                Meta clicks arrive with no <code className="font-mono">fbclid</code> or{" "}
                <code className="font-mono">utm_medium</code>, so they are indistinguishable
                from organic Instagram reach and land in organic-social. This is the single
                biggest reason paid journeys are invisible, and it is a copy-paste change to
                ad URLs rather than an engineering project.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-neutral-400">•</span>
              <span>
                <strong className="text-neutral-800 dark:text-neutral-200">
                  Cross-session identity.
                </strong>{" "}
                A returning visitor on a new device starts a fresh journey today, which is part
                of why single-session orders dominate. Stitching sessions to a customer once
                they identify would merge those.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-neutral-400">•</span>
              <span>
                <strong className="text-neutral-800 dark:text-neutral-200">
                  Not a better attribution model.
                </strong>{" "}
                With multi-touch at {pct(multiShare)} of orders, model choice moves almost
                nothing. Recoverable revenue by inheriting each customer&apos;s stamped
                acquisition channel is{" "}
                {formatUsd(coverage.revenueInheritableCents, { compact: true })} — run{" "}
                <code className="font-mono">run.cmd attribution --inherit</code> to see that
                basis rather than modelling the sessions you already have more cleverly.
              </span>
            </li>
          </ul>
        </Card>
      </main>
    </div>
  );
}

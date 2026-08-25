import Link from "next/link";
import { requireCapability } from "@/lib/auth/current-user";
import {
  getSubscriptionPlans,
  groupByCadence,
  type Cadence,
  type CadenceGroup,
} from "@/metrics/subscription-plans";
import { Card, Caveat, InfoTip, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

/**
 * The subscription book as one thing.
 *
 * Nothing showed it before. `/churn` splits by Skio plan name, `/forecast` splits by source,
 * and answering "how many quarterly subscribers are there" meant knowing that Skio calls it
 * "Quarterly Subscription", Stripe calls it "$30/quarter", and Stripe states a yearly interval
 * as `count=1` where Skio would say 12.
 *
 * Cadence is the key because it is the one property both systems state truthfully. Price is
 * not: Stripe's annual subscribers sit on three different prices, so price would invent four
 * plans out of one product.
 */

const CADENCE_LABEL: Record<Cadence, string> = {
  quarterly: "Quarterly",
  annual: "Annual",
  monthly: "Monthly",
  other: "Other cadences",
};

const PLATFORM_LABEL: Record<string, string> = {
  skio: "Skio (via Shopify)",
  stripe: "Stripe (Craft)",
};

function CadenceCard({ g }: { g: CadenceGroup }) {
  const churned = g.total - g.live;
  return (
    <Card
      title={`${CADENCE_LABEL[g.cadence]} — ${formatNum(g.live)} live`}
      subtitle={
        churned > 0
          ? `${formatNum(g.total)} ever, so ${formatNum(churned)} have ended`
          : undefined
      }
      action={
        <span className="text-sm font-medium tabular-nums">
          {formatUsd(g.annualisedCents)}
          <span className="ml-1 text-xs font-normal text-neutral-500">/yr</span>
        </span>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Per billing cycle"
          value={formatUsd(g.cycleRevenueCents)}
          hint={
            g.cadence === "annual"
              ? "a cycle is a year here"
              : g.cadence === "quarterly"
                ? "a cycle is three months"
                : "one cycle at list price"
          }
        />
        <Stat
          label="Annualised"
          value={formatUsd(g.annualisedCents)}
          hint="the figure comparable across cadences"
        />
        <Stat
          label="Monthly MRR"
          value={formatUsd(g.liveMrrCents)}
          hint="as the platforms report it"
        />
      </div>

      {g.unpricedLive > 0 ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          {formatNum(g.unpricedLive)} live subscription(s) have no establishable price and are
          excluded from the revenue figures above — counted here rather than treated as zero,
          which would have understated the total with nothing to show it.
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
            By platform
          </div>
          <div className="space-y-1">
            {g.byPlatform.map((p) => {
              const share = g.live > 0 ? p.live / g.live : null;
              return (
                <div key={p.platform} className="flex items-baseline gap-2 text-sm">
                  <span className="w-40 shrink-0 text-neutral-700 dark:text-neutral-300">
                    {PLATFORM_LABEL[p.platform] ?? p.platform}
                  </span>
                  <span className="tabular-nums font-medium">{formatNum(p.live)}</span>
                  {share !== null ? (
                    <span className="text-xs text-neutral-500">
                      {(share * 100).toFixed(0)}% of this cadence
                    </span>
                  ) : null}
                  {p.total > p.live ? (
                    <span className="text-xs text-neutral-400">
                      · {formatNum(p.total - p.live)} ended
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Price points
            <InfoTip label="Why prices are listed rather than averaged" width="26rem">
              A cadence can hold several prices. Stripe&rsquo;s annual subscribers sit on
              $100/year, $50 a year and $80 a year — the last two legacy — so an average would
              report a plan nobody is actually on. Skio prices come from the shared table the
              renewal forecast uses, so the two cannot disagree; Stripe states its price in the
              plan nickname, which is parsed.
            </InfoTip>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {g.plans.map((p) => (
                  <tr
                    key={`${p.platform}-${p.planName ?? "none"}`}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                  >
                    <td className="py-1.5 pr-3 text-neutral-700 dark:text-neutral-300">
                      {p.planName ?? (
                        <span className="text-neutral-500">
                          no plan name
                          <InfoTip label="Subscriptions with no plan name">
                            Skio hands these over without one. They are priced by billing
                            cadence instead, which identifies them unambiguously — the same rule
                            the renewal forecast uses.
                          </InfoTip>
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-neutral-500">
                      {PLATFORM_LABEL[p.platform] ?? p.platform}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {p.priceCents === null ? (
                        <span className="text-amber-600 dark:text-amber-400">no price</span>
                      ) : (
                        formatUsd(p.priceCents)
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-medium">
                      {formatNum(p.live)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default async function PlansPage() {
  const user = await requireCapability("revenue");
  const rows = await getSubscriptionPlans();
  const groups = groupByCadence(rows);

  const live = groups.reduce((a, g) => a + g.live, 0);
  const total = groups.reduce((a, g) => a + g.total, 0);
  const annualised = groups.reduce((a, g) => a + g.annualisedCents, 0);
  const unpriced = groups.reduce((a, g) => a + g.unpricedLive, 0);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Subscription plans</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Both platforms in one taxonomy, grouped by how often they bill.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Live subscriptions"
            value={formatNum(live)}
            hint="active, trialing or past due"
            emphasis
          />
          <Stat
            label="Ever created"
            value={formatNum(total)}
            hint={`${formatNum(total - live)} have ended`}
          />
          <Stat
            label="Annualised at list price"
            value={formatUsd(annualised)}
            hint="one full year of the live book"
          />
          <Stat
            label="Cadences in use"
            value={String(groups.length)}
            hint={groups.map((g) => CADENCE_LABEL[g.cadence].toLowerCase()).join(", ")}
          />
        </div>

        <Caveat summary="Annualised list price is not a forecast, and MRR is not revenue.">
          The annualised figure is what the live book would collect in a year if every
          subscription renewed at its list price. Nobody renews at 100%, so treat it as a
          ceiling — <Link href="/forecast" className="underline decoration-dotted underline-offset-2">Forecast</Link>{" "}
          applies the actual billing dates. Separately, the platforms&rsquo; MRR carries sales tax
          in the regions that charge it, so it runs slightly above the ex-tax list prices; that
          is why the revenue figures here come from the price table rather than from MRR.
        </Caveat>

        {unpriced > 0 ? (
          <Caveat
            summary={`${formatNum(unpriced)} live subscription(s) have no establishable price.`}
          >
            They are excluded from every revenue figure on this page and counted where they
            occur, rather than being treated as zero — a zero sums into a total silently and
            understates it with nothing on screen to say so.
          </Caveat>
        ) : null}

        {groups.map((g) => (
          <CadenceCard key={g.cadence} g={g} />
        ))}

        {groups.length === 0 ? (
          <Card title="No subscriptions">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Neither platform has returned any subscriptions yet.
            </p>
          </Card>
        ) : null}

        <p className="text-xs text-neutral-500">
          Churn and cohort behaviour by plan is on{" "}
          <Link href="/churn" className="underline decoration-dotted underline-offset-2">
            Churn &amp; cohorts
          </Link>
          ; the renewal schedule is on{" "}
          <Link href="/forecast" className="underline decoration-dotted underline-offset-2">
            Forecast
          </Link>
          .
        </p>
      </main>
    </div>
  );
}

import { requireCapability } from "@/lib/auth/current-user";
import { resolvePageRange } from "@/lib/date-range.server";
import {
  getDiscountReview,
  MIN_ORDERS_TO_JUDGE,
  type CodeVerdict,
  type DiscountCodeRow,
} from "@/metrics/discounts";
import { Badge, Card, Caveat, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { DateRangePicker } from "../_components/date-range-picker";

export const dynamic = "force-dynamic";

const pct = (v: number | null, dp = 0) => (v == null ? "—" : `${(v * 100).toFixed(dp)}%`);
const money = (v: number | null) => (v == null ? "—" : formatUsd(v));

const VERDICT_TONE: Record<CodeVerdict, "neutral" | "amber" | "emerald" | "blue"> = {
  review: "amber",
  watch: "amber",
  acquisition: "blue",
  healthy: "emerald",
  "too-few": "neutral",
};

const VERDICT_LABEL: Record<CodeVerdict, string> = {
  review: "review",
  watch: "watch",
  acquisition: "acquisition",
  healthy: "healthy",
  "too-few": "too few",
};

/**
 * The delta against baseline.
 *
 * Rendered as a signed figure with the word, never as a bare colour — the same rule the charts
 * follow. A code that gives away margin ON PURPOSE is not a failure, so this shows the size of
 * the gap and leaves the judgement to the verdict beside it.
 */
function VsBaseline({ row }: { row: DiscountCodeRow }) {
  if (row.vsBaselineCents === null || row.vsBaselineShare === null) {
    return <span className="text-neutral-400">—</span>;
  }
  const up = row.vsBaselineCents >= 0;
  return (
    <span
      className={
        up
          ? "whitespace-nowrap text-emerald-600 dark:text-emerald-400"
          : "whitespace-nowrap text-neutral-600 dark:text-neutral-400"
      }
    >
      {up ? "+" : "−"}
      {formatUsd(Math.abs(row.vsBaselineCents))} ({up ? "+" : "−"}
      {Math.abs(Math.round(row.vsBaselineShare * 100))}%)
    </span>
  );
}

export default async function DiscountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Margin data, so gated on margin — not on who happens to run promotions.
  const user = await requireCapability("margin");
  const { range, compareMode, comparison, bounds } = await resolvePageRange(await searchParams);
  const review = await getDiscountReview(range.since, range.until);

  const judged = review.codes.filter((c) => c.verdict !== "too-few");

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Discount codes</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            What each code costs against what an order with no code earns · {range.label}
          </p>
        </div>

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

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Baseline CM2 / order"
            value={money(review.baseline.cm2PerPaidOrder)}
            hint={`${formatNum(review.baseline.paidOrders)} paid orders with no code · ${pct(review.baseline.cm2Margin, 1)} margin`}
            emphasis
          />
          <Stat
            label="Discount given"
            value={formatUsd(review.discountGivenCents, { compact: true })}
            hint={`across ${formatNum(review.codedOrders)} coded orders`}
            emphasis
          />
          <Stat
            label="Codes to review"
            value={`${review.needsReview} / ${judged.length}`}
            hint={`${review.codes.length - judged.length} more below ${MIN_ORDERS_TO_JUDGE} orders`}
          />
          <Stat
            label="First-time share"
            value={pct(review.baseline.firstOrderShare)}
            hint="of uncoded orders — the comparison caveat below"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Caveat summary="Coded and uncoded orders are different populations" tone="warn">
            The baseline is {pct(review.baseline.firstOrderShare)} first-time buyers, while a
            welcome code is close to 100% first-time. Comparing them measures &ldquo;first order
            versus any order&rdquo; as much as it measures the code. The <em>first-time</em>{" "}
            column is there so you can see when the comparison is unlike-for-unlike.
          </Caveat>

          <Caveat summary="Averages are over paid orders only">
            A $0 order carries COGS with no revenue, because its money is recognised in Skio.
            Including those would measure giveaway volume rather than code performance. Dividing
            by every order put this baseline at −$1.31 — claiming the average undiscounted order
            loses money. It doesn&rsquo;t: it earns {money(review.baseline.cm2PerPaidOrder)}.
          </Caveat>

          <Caveat summary="Giveaways are labelled, not ranked">
            A code on a free-issue offer has negative margin by design. It is marked{" "}
            <em>acquisition</em> and judged on what those customers do next — the same treatment
            free-offer campaigns get on Campaigns &amp; creatives.
          </Caveat>

          <Caveat summary="CM2 boundary">{review.boundary}</Caveat>
        </div>

        <Card
          title="Codes"
          subtitle="Worst first — what needs a decision, not what is biggest."
        >
          {review.codes.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              No marketing codes were used in this range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Code</th>
                    <th className="py-2 pr-3 text-right font-medium">Orders</th>
                    <th className="py-2 pr-3 text-right font-medium">Paid</th>
                    <th className="py-2 pr-3 text-right font-medium">CM2 / paid order</th>
                    <th className="py-2 pr-3 text-right font-medium">vs baseline</th>
                    <th className="py-2 pr-3 text-right font-medium">Given away</th>
                    <th className="py-2 pr-3 text-right font-medium">First-time</th>
                    <th className="py-2 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody className="text-neutral-700 dark:text-neutral-300">
                  {review.codes.map((c) => (
                    <tr
                      key={c.code}
                      className="border-t border-neutral-100 align-top dark:border-neutral-800"
                    >
                      <td className="py-2 pr-3">
                        <div className="font-mono text-xs font-medium">{c.code}</div>
                        <div className="mt-0.5 max-w-md text-[11px] text-neutral-500 dark:text-neutral-400">
                          {c.note}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatNum(c.orders)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                        {formatNum(c.paidOrders)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {money(c.cm2PerPaidOrder)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <VsBaseline row={c} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                        {formatUsd(c.discountCents, { compact: true })}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                        {pct(c.firstOrderShare)}
                      </td>
                      <td className="py-2">
                        <Badge tone={VERDICT_TONE[c.verdict]}>{VERDICT_LABEL[c.verdict]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}

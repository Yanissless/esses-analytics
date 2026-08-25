import Link from "next/link";
import { requireCapability } from "@/lib/auth/current-user";
import {
  listOrdersForReview,
  listRecentlyDecided,
  pendingReviewValue,
  type ReviewOrder,
} from "@/lib/review/order-review";
import { Badge, Card, InfoTip, Stat, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { decideMany, decideOrder, undoDecision } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The review queue — orders where Shopify collected no money.
 *
 * ## Why this page exists
 *
 * It already existed, as `pnpm review` in a terminal. The Overview page said "5 order(s)
 * awaiting review ($1,295.93) — excluded until confirmed. Run pnpm review", which is a
 * reasonable thing to tell the person who wrote it and an unreasonable thing to tell anyone
 * else. The people who will actually clear this queue are not going to open a shell, so in
 * practice the queue never got cleared and $1,295.93 sat outside revenue indefinitely.
 *
 * Modelled on QuickBooks' unassigned-transactions view, which gets the shape right: the
 * evidence you need to decide sits on the row, the decision is one click, and you can undo it.
 *
 * ## Why each order shows customer history
 *
 * The judgement is "was this a sale or a gift", and the order alone rarely settles it. A $0
 * order from someone who has paid $240 across six orders is almost certainly a subscription
 * fulfilment; the same order from an address with no history is a press copy. Both look
 * identical if you only show the order.
 */

const dt = (d: Date | null) =>
  d ? d.toLocaleDateString("en-US", { dateStyle: "medium" }) : "—";

/** Plain-English version of the machine reason, since the raw value is a slug. */
function whyFlagged(reason: string | null): string {
  if (!reason) return "No payment recorded in Shopify";
  const map: Record<string, string> = {
    zero_total: "Order total is $0",
    no_payment: "No payment was collected",
    unpaid: "Marked unpaid in Shopify",
    partially_paid: "Only partly paid",
    refunded_full: "Fully refunded",
  };
  return map[reason] ?? reason.replace(/_/g, " ");
}

/**
 * The evidence line.
 *
 * Kept to one sentence on purpose. A reviewer deciding thirty of these reads the shape of the
 * row, not a paragraph, so the signal that decides most cases — has this person ever paid us —
 * has to be the thing the eye lands on.
 */
function CustomerEvidence({ o }: { o: ReviewOrder }) {
  const hasHistory = o.customerOrderCount > 1 || o.customerPaidTotal > 0;
  return (
    <div className="text-xs text-neutral-500 dark:text-neutral-400">
      {o.customerName || o.customerEmail || "No customer on the order"}
      {hasHistory ? (
        <>
          {" · "}
          <span className="text-neutral-700 dark:text-neutral-300">
            {o.customerOrderCount} order{o.customerOrderCount === 1 ? "" : "s"},{" "}
            {formatUsd(o.customerPaidTotal)} paid overall
          </span>
        </>
      ) : (
        <>
          {" · "}
          <span className="text-amber-600 dark:text-amber-400">never paid us anything</span>
        </>
      )}
      {o.isSubscriber ? (
        <>
          {" · "}
          <span className="text-emerald-700 dark:text-emerald-500">subscriber</span>
        </>
      ) : null}
    </div>
  );
}

export default async function ReviewPage() {
  // `revenue`, not `settings`: this is a judgement about revenue, made by whoever reads the
  // revenue numbers. Gating it behind admin leaves the queue full while the one person who
  // can clear it is busy.
  const user = await requireCapability("revenue");

  const [pending, decided, pendingCents] = await Promise.all([
    listOrdersForReview(200),
    listRecentlyDecided(25),
    pendingReviewValue(),
  ]);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Orders to review</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Shopify collected no money on these, so they are held out of revenue until someone
            says what they were. Nothing here counts until you decide.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Awaiting a decision"
            value={String(pending.length)}
            hint={pending.length === 0 ? "queue is clear" : "held out of revenue"}
            emphasis
          />
          <Stat
            label="Value being withheld"
            value={formatUsd(pendingCents)}
            hint="face value of the held orders"
          />
          <Stat
            label="Decided"
            value={String(decided.length)}
            hint={decided.length ? "most recent shown below" : "nothing decided yet"}
          />
        </div>

        {pending.length === 0 ? (
          <Card title="Nothing to review">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Every un-paid order has been accounted for. New ones appear here automatically
              when they arrive — there is nothing to run and nothing to check.
            </p>
          </Card>
        ) : (
          <Card
            title={`${pending.length} order${pending.length === 1 ? "" : "s"} to decide`}
            info={
              "Two questions, and the customer history usually answers both. Was money taken " +
              "some other way — a Stripe subscription, an annual plan already paid — in which " +
              "case this is a fulfilment and should count? Or was it given away, in which case " +
              "it is a comp and stays out of revenue. Anything you decide can be undone below."
            }
          >
            {/* Rows are NOT nested inside the bulk form — nested forms are invalid HTML, and
                the shared hidden inputs made every row's per-row buttons read the first row's
                id. Each row now owns small forms with their arguments bound, and the tick
                boxes associate with the bulk form below by its id, which is what the HTML
                `form` attribute is for. */}
            <div className="space-y-2">
              {pending.map((o) => (
                <div
                  key={o.orderId}
                  className="flex flex-wrap items-start gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <input
                    type="checkbox"
                    name="orderIds"
                    value={o.orderId}
                    form="review-bulk"
                    aria-label={`Select order ${o.orderNumber ?? o.orderId}`}
                    className="mt-1 h-4 w-4 shrink-0 rounded border-neutral-300 dark:border-neutral-600"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{o.orderNumber ?? "(no number)"}</span>
                      <span className="text-sm text-neutral-500">{dt(o.processedAt)}</span>
                      <span className="text-sm font-medium tabular-nums">
                        {formatUsd(o.totalAmount)}
                      </span>
                      <Badge>{whyFlagged(o.reviewReason)}</Badge>
                    </div>
                    <CustomerEvidence o={o} />
                    {o.items ? (
                      <div className="mt-0.5 truncate text-xs text-neutral-500" title={o.items}>
                        {o.items}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <form action={decideOrder.bind(null, o.orderId, "include")}>
                      <button
                        type="submit"
                        className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950"
                      >
                        Count as revenue
                      </button>
                    </form>
                    <form action={decideOrder.bind(null, o.orderId, "exclude")}>
                      <button
                        type="submit"
                        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        It was a gift
                      </button>
                    </form>
                  </div>
                </div>
              ))}
            </div>

            {/* The bulk form carries the action itself, so React puts its action id in a
                hidden input and these buttons keep their own name/value. */}
            <form
              id="review-bulk"
              action={decideMany}
              className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
            >
              <span className="text-xs text-neutral-500">
                With the ticked orders:
                <InfoTip label="Why there is no decide-everything button">
                  The ids come from boxes you ticked, so the set is always something you chose to
                  look at. A button that decided the whole list without anyone reading it would
                  defeat the point of the queue.
                </InfoTip>
              </span>
              <button
                type="submit"
                name="decision"
                value="include"
                className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950"
              >
                Count all ticked as revenue
              </button>
              <button
                type="submit"
                name="decision"
                value="exclude"
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Mark all ticked as gifts
              </button>
            </form>
          </Card>
        )}

        {decided.length > 0 ? (
          <Card
            title="Already decided"
            subtitle="Undo puts an order back in the queue exactly as it was found."
            info="A reviewer working down a list will misclick. Without an undo the only remedy is a database edit, which for the people clearing this queue means asking someone else to fix it."
          >
            <div className="space-y-1.5">
              {decided.map((d) => (
                <form
                  key={d.orderId}
                  action={undoDecision.bind(null, d.orderId)}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                >
                  <span
                    className={`w-28 shrink-0 text-xs font-medium ${
                      d.decision === "include"
                        ? "text-emerald-700 dark:text-emerald-500"
                        : "text-neutral-500"
                    }`}
                  >
                    {d.decision === "include" ? "counted" : "gift"}
                  </span>
                  <span className="font-medium">{d.orderNumber ?? "(no number)"}</span>
                  <span className="text-neutral-500">{dt(d.processedAt)}</span>
                  <span className="tabular-nums text-neutral-600 dark:text-neutral-400">
                    {formatUsd(d.totalAmount)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
                    {d.customerName || d.customerEmail || ""}
                  </span>
                  <button
                    type="submit"
                    className="shrink-0 text-xs text-neutral-500 underline decoration-dotted underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    Undo
                  </button>
                </form>
              ))}
            </div>
          </Card>
        ) : null}

        <p className="text-xs text-neutral-500">
          Counting an order as revenue changes the figures on{" "}
          <Link href="/" className="underline decoration-dotted underline-offset-2">
            Overview
          </Link>{" "}
          and{" "}
          <Link href="/profit" className="underline decoration-dotted underline-offset-2">
            Profit
          </Link>{" "}
          immediately. Decisions survive future syncs.
        </p>
      </main>
    </div>
  );
}

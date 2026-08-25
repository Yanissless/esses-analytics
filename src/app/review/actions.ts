"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { orders } from "@/db/schema";
import { requireCapability } from "@/lib/auth/current-user";
import { setReviewDecision, type ReviewDecision } from "@/lib/review/order-review";

/**
 * Deciding what an un-paid order actually was.
 *
 * These write `review_override`, which the metrics layer trusts over its own automatic
 * classification, so a decision here changes revenue. Two consequences:
 *
 *  - It needs the `revenue` capability. Not `settings` — this is a judgement about revenue,
 *    made by whoever reads the revenue numbers, and gating it behind admin would leave the
 *    queue permanently full while the one person who can clear it is busy.
 *  - Every path revalidates `/` as well as `/review`, because the Overview banner counts the
 *    queue. Without that, clearing the last item leaves the banner claiming work remains.
 *
 * ## Why the single-order actions take arguments instead of reading FormData
 *
 * The first version put the order id in a hidden input and the decision on the submit button
 * as `name="decision" value="include"`, with `formAction` pointing at the action. It silently
 * did nothing, and the hydration warning said exactly why: for a `formAction` server action
 * React puts its own `$ACTION_ID_…` in the button's **name** attribute. Setting `name` myself
 * overwrote it, so the browser posted a form with no action id and the server had nothing to
 * run. No error — just a button that looked fine and did nothing.
 *
 * Binding the arguments avoids the whole mechanism: `decideOrder.bind(null, id, "include")`
 * needs no form fields, so there is nothing for React to collide with.
 */

/** Revalidate everything whose numbers move when a decision lands. */
function revalidateAffected(): void {
  revalidatePath("/review");
  // The Overview banner and the revenue tiles both change.
  revalidatePath("/");
  revalidatePath("/profit");
}

/** Decide one order. Both arguments are bound at render time — see the note above. */
export async function decideOrder(
  orderId: string,
  decision: ReviewDecision,
): Promise<void> {
  await requireCapability("revenue");
  if (!orderId) return;
  if (decision !== "include" && decision !== "exclude") return;

  await setReviewDecision(orderId, decision);
  revalidateAffected();
}

/**
 * Put a decided order back in the queue.
 *
 * The equivalent of QuickBooks' undo, and it matters more than it looks: a reviewer working
 * through a list will misclick, and without a way back the only remedy is a database edit —
 * which, for the people who will actually be clearing this queue, means asking someone else.
 *
 * `counts_as_revenue` returns to false because that is what "awaiting review" means: excluded
 * until confirmed. Leaving it true would quietly count an order that is undecided again.
 */
export async function undoDecision(orderId: string): Promise<void> {
  await requireCapability("revenue");
  if (!orderId) return;

  await db
    .update(orders)
    .set({ reviewOverride: null, needsReview: true, countsAsRevenue: false })
    .where(eq(orders.id, orderId));

  revalidateAffected();
}

/**
 * Decide several orders at once.
 *
 * The queue's common shape is a run of obviously-similar orders — a batch of press copies, a
 * set of $0 subscription fulfilments — and making someone click through thirty of those one at
 * a time is how a review queue stops getting used.
 *
 * This one reads FormData because the ids come from checkboxes. Its buttons CAN carry
 * `name="decision"`, unlike the per-row case: the collision above only happens with
 * `formAction`, where React needs the button's name for the action id. Here the form itself
 * carries the action, so React puts the id in a hidden input and leaves the buttons alone.
 *
 * Deliberately NOT a "decide everything" button. The ids come from boxes the reviewer ticked,
 * so the set is always something they chose to look at; a blanket action over a list nobody
 * read would defeat the point of the queue existing.
 */
export async function decideMany(formData: FormData): Promise<void> {
  await requireCapability("revenue");

  const decision = String(formData.get("decision") ?? "");
  if (decision !== "include" && decision !== "exclude") return;

  const ids = formData.getAll("orderIds").map(String).filter(Boolean);
  if (ids.length === 0) return;

  for (const id of ids) {
    await setReviewDecision(id, decision as ReviewDecision);
  }
  revalidateAffected();
}

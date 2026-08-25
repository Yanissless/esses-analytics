/**
 * The app refreshing its own data, triggered by a page view rather than a person.
 *
 * Separate from `/api/sync` on purpose, because the two answer to different callers:
 *
 *   /api/sync     a scheduler. Authenticated by CRON_SECRET, no session, runs whatever it is
 *                 asked for, no rate limiting — the schedule IS the rate limit.
 *   /api/refresh  a logged-in browser. Authenticated by session, and heavily gated, because
 *                 the trigger is a page view and page views are not rate limited.
 *
 * Merging them would mean either exposing a session-authed endpoint that a scheduler could
 * hammer, or giving a browser an endpoint with no cooldown. Both spend third-party API calls.
 *
 * ## Why it re-checks the decision it was given
 *
 * The client only calls this when the server render said the data was stale. It checks again
 * anyway. Between render and fetch, another tab — or the cron, or someone else's dashboard —
 * may have started a sync, and "the page told me to" is not a fact about the present.
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { logger } from "@/lib/logger";
import { getRefreshState } from "@/lib/sync/auto-refresh.server";
import { runSync } from "@/lib/sync/run-sync";

/** DB-bound and long-running; must not run on the Edge runtime. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A measured incremental sync is ~63s. This is the platform maximum, requested so a slow
 * third-party day does not truncate a run mid-write. See the note in /api/sync/route.ts about
 * why an external kill is worse than a plain failure.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  // getCurrentUser, not requireUser or requireCapability: both of those call redirect(),
  // which in an API route answers a background fetch with a 307 to /login. The caller is
  // JavaScript, not a browser navigating, so it needs a status code it can act on.
  //
  // Any signed-in role may trigger it. Deliberately not gated on a capability — keeping data
  // fresh is not privileged, and gating it would mean a viewer's dashboard silently never
  // refreshed while an admin's did.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ started: false, error: "Not signed in." }, { status: 401 });
  }

  /*
   * `?force=1` — somebody pressed a button.
   *
   * The four gates exist to stop a PAGE VIEW spending third-party API calls, which is a
   * decision nobody made. A click is a decision somebody made, and refusing it because the
   * data is 20 minutes short of the staleness threshold makes the button look broken —
   * exactly the "why is nothing happening" that sends people back to a terminal.
   *
   * The in-flight lock still applies, and deliberately: two clicks must not start two syncs
   * writing the same rows. That is the one gate protecting correctness rather than budget.
   */
  const force = new URL(request.url).searchParams.get("force") === "1";

  const state = await getRefreshState();
  const blocked = !state.decision.refresh;
  const blockedBy = state.decision.refresh ? null : state.decision.blockedBy;

  if (blocked && (!force || blockedBy === "in-flight")) {
    // Not an error. The common case is two tabs racing, and the loser has nothing to do.
    return NextResponse.json({
      started: false,
      reason:
        force && blockedBy === "in-flight"
          ? "A sync is already running — this one would write the same rows."
          : state.decision.reason,
      blockedBy,
    });
  }

  logger.info("auto-refresh starting", {
    triggeredBy: user.email,
    reason: state.decision.reason,
    ageMinutes: state.decision.ageMinutes,
  });

  try {
    const summary = await runSync({});
    logger.info("auto-refresh done", {
      ok: summary.ok,
      ms: summary.ms,
      failed: summary.failed,
    });
    return NextResponse.json({
      started: true,
      ok: summary.ok,
      ms: summary.ms,
      failed: summary.failed,
      metricsDays: summary.metricsDays,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("auto-refresh failed", { error });
    // 200 with ok:false, not a 5xx. The caller is a background fetch from a page the user is
    // reading; a failed refresh is information for the indicator, not a broken request.
    return NextResponse.json({ started: true, ok: false, error }, { status: 200 });
  }
}

"use client";

/**
 * Starts a data refresh when the page loads and the data is stale, with nothing to click.
 *
 * This is the only Client Component in the app that does work rather than presentation, so the
 * reasoning is worth stating.
 *
 * ## Why the trigger is here and not on the server
 *
 * The obvious version fires the sync from the Server Component during render. That breaks in
 * two ways. It blocks the page — a 63-second sync means a 63-second blank screen — and on a
 * serverless host the request context is torn down when the response is sent, so a
 * fire-and-forget promise is killed part way through, mid-write.
 *
 * Doing it from the client separates the two: the page renders immediately, and the refresh is
 * its own request with its own lifetime and its own timeout.
 *
 * ## Why a ref rather than only the effect's dependency list
 *
 * React 18+ runs effects twice in development Strict Mode, deliberately. Without the ref that
 * is two syncs, and the server-side cooldown would reject the second — so it would look like
 * it worked while actually testing the failure path every time.
 *
 * ## It never blocks and never nags
 *
 * A failed refresh shows a quiet line, not a dialog. The data on screen is still the data that
 * was there a moment ago; nothing has become wrong. And `router.refresh()` on success re-renders
 * server components in place, so the numbers update without a visible reload or losing scroll
 * position.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Phase = "idle" | "running" | "done" | "failed" | "skipped" | "signed-out";

export function AutoRefresh({
  stale,
  inFlight,
  lastFinishedAt,
}: {
  /** From the server's `getRefreshState()`. False means every gate said no. */
  stale: boolean;
  /** A sync was already running at render time. Show it, don't start another. */
  inFlight: boolean;
  lastFinishedAt: string | null;
}) {
  const router = useRouter();
  const fired = useRef(false);
  const [phase, setPhase] = useState<Phase>(inFlight ? "running" : "idle");

  useEffect(() => {
    if (!stale || inFlight || fired.current) return;
    fired.current = true;

    let cancelled = false;
    setPhase("running");

    fetch("/api/refresh", { method: "POST" })
      .then(async (r) => {
        // A signed-out session is not a refresh failure, and saying "couldn't update data"
        // when the truth is "you are logged out" sends someone looking for a data problem
        // that doesn't exist. The proxy returns 401 for /api/* precisely so this is
        // distinguishable.
        if (r.status === 401) return { signedOut: true as const };
        return (await r.json()) as { started?: boolean; ok?: boolean };
      })
      .then((body: { started?: boolean; ok?: boolean; signedOut?: boolean }) => {
        if (cancelled) return;
        if (body.signedOut) {
          setPhase("signed-out");
          return;
        }
        if (!body.started) {
          // Another tab or the cron got there first. Nothing went wrong.
          setPhase("skipped");
          return;
        }
        if (body.ok) {
          setPhase("done");
          // Re-render the server components so the new numbers appear without a reload.
          router.refresh();
        } else {
          setPhase("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setPhase("failed");
      });

    return () => {
      // Guards against setting state after unmount during a navigation. The request itself is
      // deliberately NOT aborted — it is writing to the database, and abandoning a sync part
      // way through because someone clicked a link is worse than letting it finish.
      cancelled = true;
    };
  }, [stale, inFlight, router]);

  if (phase === "idle") return null;

  const text =
    phase === "running"
      ? "Updating data…"
      : phase === "done"
        ? "Data updated"
        : phase === "skipped"
          ? "Already up to date"
          : phase === "signed-out"
            ? "Session expired — reload to sign in"
            : "Couldn't update data";

  const body = (
    <>
      {phase === "running" ? (
        <span
          aria-hidden
          className="h-2 w-2 animate-pulse rounded-full bg-neutral-400 dark:bg-neutral-500"
        />
      ) : null}
      {text}
    </>
  );

  const className = `inline-flex items-center gap-1.5 text-xs ${
    phase === "failed" || phase === "signed-out"
      ? "text-amber-600 dark:text-amber-400"
      : "text-neutral-500 dark:text-neutral-400"
  }`;

  // A failure is the one case with somewhere to go, so it links there. Telling someone to check
  // the log without giving them the log is how a message ends up being decoration.
  if (phase === "failed") {
    return (
      <Link
        href="/data"
        className={`${className} underline decoration-dotted underline-offset-2 hover:opacity-80`}
        title="The figures on screen are the last good ones — nothing has become wrong. Open the run log to see what failed."
      >
        {body}
      </Link>
    );
  }

  return (
    <span
      className={className}
      title={lastFinishedAt ? `Last completed sync: ${lastFinishedAt}` : undefined}
    >
      {body}
    </span>
  );
}

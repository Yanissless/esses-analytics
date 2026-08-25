"use client";

/**
 * "Update data now" — the button that replaces telling somebody to run a command.
 *
 * ## Why this exists
 *
 * Half the app used to end a sentence with `Run run.cmd sync`. That is a reasonable thing to
 * tell the person who built it and useless to everyone else: the people who will actually pull
 * data out of this are not going to open a shell, so in practice the instruction meant "this
 * number stays stale". The work was already possible — `/api/refresh` runs exactly the same
 * sync — there was simply no way to ask for it.
 *
 * ## Why it forces
 *
 * The automatic refresh is gated on staleness and a cooldown, because a page view spending
 * third-party API calls is a decision nobody made. A click is a decision somebody made, so it
 * passes `force=1`, which skips those two gates. The in-flight lock still applies: two clicks
 * must not start two syncs writing the same rows.
 *
 * ## Why it reports rather than silently finishing
 *
 * A sync takes about a minute. A button that goes quiet for a minute reads as broken, and the
 * second click is the one that does damage — so the label carries the state the whole way
 * through, and the disabled attribute makes a second click impossible rather than merely
 * discouraged.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Phase = "idle" | "running" | "done" | "skipped" | "failed" | "signed-out";

export function RefreshButton({
  label = "Update data now",
  className,
}: {
  label?: string;
  /** Overridden where the button sits inside a coloured banner. */
  className?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  // useTransition so router.refresh()'s re-render is tracked; without it the button reports
  // "done" while the page below is still showing the old numbers.
  const [pending, startTransition] = useTransition();

  const run = async () => {
    setPhase("running");
    try {
      const r = await fetch("/api/refresh?force=1", { method: "POST" });
      if (r.status === 401) {
        setPhase("signed-out");
        return;
      }
      const body = (await r.json()) as { started?: boolean; ok?: boolean };
      if (!body.started) {
        setPhase("skipped");
        return;
      }
      if (body.ok) {
        setPhase("done");
        startTransition(() => router.refresh());
      } else {
        setPhase("failed");
      }
    } catch {
      setPhase("failed");
    }
  };

  const busy = phase === "running" || pending;

  const text =
    phase === "running"
      ? "Updating…"
      : pending
        ? "Loading new figures…"
        : phase === "done"
          ? "Updated"
          : phase === "skipped"
            ? "A sync is already running"
            : phase === "signed-out"
              ? "Session expired — reload"
              : phase === "failed"
                ? "Couldn't update — try again"
                : label;

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className={
        className ??
        "rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      }
      // Around a minute. Said up front rather than discovered, because the alternative is
      // someone deciding it has hung.
      title="Fetches the latest orders, ad spend and subscriptions. Takes about a minute."
    >
      {text}
    </button>
  );
}

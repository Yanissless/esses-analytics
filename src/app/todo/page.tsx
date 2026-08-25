import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { getTodos, type TodoOwner } from "@/lib/todos.server";
import { Card, Stat } from "../_components/ui";
import { Nav } from "../_components/nav";
import { RefreshButton } from "../_components/refresh-button";

export const dynamic = "force-dynamic";

/**
 * What's outstanding — computed, not written down.
 *
 * The same information used to live in a "Waiting on Sam" table in START-HERE.md, a
 * blocked-on section in HANDOFF.md, and whatever the last session's notes said. All three
 * drifted: `read_reports` sat on the blocked list for weeks after the scope was granted, and
 * it was only caught because a deploy check printed the token's real scopes.
 *
 * Every item on this page asks the database or the environment whether it is still true, so an
 * item that has been dealt with stops appearing without anyone editing anything.
 *
 * No capability gate. Knowing what is outstanding is not privileged, and the items themselves
 * link to pages that guard independently.
 */

const OWNER_LABEL: Record<TodoOwner, string> = {
  you: "You can do this now",
  "someone-else": "Needs the social manager or a developer",
  external: "Waiting on an outside approval",
  time: "Only time fixes it",
};

const OWNER_TONE: Record<TodoOwner, string> = {
  you: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  "someone-else": "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  external: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  time: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500",
};

export default async function TodoPage() {
  const user = await requireUser();
  const { items, actionable } = await getTodos();

  // Grouped for reading, but the order within each group is already decided by sortTodos.
  const groups: TodoOwner[] = ["you", "someone-else", "external", "time"];

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">What&rsquo;s outstanding</h1>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              Worked out from the current data every time this page loads, so nothing here is a
              stale note. An item that gets dealt with disappears on its own.
            </p>
          </div>
          <RefreshButton />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="You can finish these"
            value={String(actionable)}
            hint={actionable === 0 ? "nothing waiting on you" : "no one else is blocking them"}
            emphasis
          />
          <Stat
            label="Waiting on someone else"
            value={String(items.filter((i) => i.owner !== "you" && i.owner !== "time").length)}
            hint="chasing is the only action"
          />
          <Stat
            label="Total tracked"
            value={String(items.length)}
            hint="everything known to be outstanding"
          />
        </div>

        {groups.map((owner) => {
          const group = items.filter((i) => i.owner === owner);
          if (group.length === 0) return null;
          return (
            <Card key={owner} title={OWNER_LABEL[owner]}>
              <ul className="space-y-4">
                {group.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-start gap-3">
                    <span
                      aria-hidden
                      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                        owner === "you" ? "bg-amber-500" : "bg-neutral-300 dark:bg-neutral-600"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{t.title}</div>
                      <div className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">
                        {t.detail}
                      </div>
                      {/* What it costs to leave undone. The reason to care, kept separate from
                          the description so a skim reads title → consequence. */}
                      <div className="mt-1 text-xs text-neutral-500">
                        <span className="font-medium">If left:</span> {t.blocks}
                      </div>
                    </div>
                    {t.href ? (
                      <Link
                        href={t.href}
                        className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition hover:opacity-80 ${OWNER_TONE[owner]}`}
                      >
                        {t.actionLabel ?? "Open"} →
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}

        {items.length === 0 ? (
          <Card title="Nothing outstanding">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              No queue, no missing credentials, no untagged traffic. Worth a screenshot.
            </p>
          </Card>
        ) : null}

        <p className="text-xs text-neutral-500">
          Data-quality problems live on{" "}
          <Link href="/data" className="underline decoration-dotted underline-offset-2">
            Data updates
          </Link>{" "}
          instead — this page is only things a person can act on.
        </p>
      </main>
    </div>
  );
}

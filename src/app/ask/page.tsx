import { requireUser } from "@/lib/auth/current-user";
import { analystConfigured } from "@/lib/ai/analyst.server";
import { ANALYST_TOOLS } from "@/lib/ai/analyst";
import { can } from "@/lib/auth/capabilities";
import { Nav } from "../_components/nav";
import { AnalystChat } from "./chat";

export const dynamic = "force-dynamic";

/**
 * Ask — the AI analyst.
 *
 * Gated on `requireUser()` rather than a capability: every role may ask questions, and
 * what differs is the toolset the agent is given, which is derived from the same
 * capability map the pages use. So a marketing user gets a working analyst that
 * genuinely cannot reach margin or individual customers, rather than a page they are
 * redirected away from. See the two gates in `lib/ai/tools.server.ts`.
 *
 * The count below is stated in the UI on purpose: a user should be able to see the
 * boundary of what they're talking to, not infer it from refusals.
 */
export default async function AskPage() {
  const user = await requireUser();
  const configured = analystConfigured();

  const available = Object.values(ANALYST_TOOLS).filter(
    (t) => !t.capability || can(user.role, t.capability),
  ).length;
  const total = Object.keys(ANALYST_TOOLS).length;

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Ask</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {available === total ? (
              <>All {total} data tools available to your role.</>
            ) : (
              <>
                {available} of {total} data tools available to your role — the rest are
                withheld from the {user.role} role, so the analyst cannot read them either.
              </>
            )}{" "}
            Read-only: nothing here changes a setting.
          </p>
        </div>
        <AnalystChat configured={configured} />
      </main>
    </div>
  );
}

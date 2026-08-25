import Link from "next/link";
import { getRefreshState } from "@/lib/sync/auto-refresh.server";
import { AutoRefresh } from "./auto-refresh";
import { NavMenus } from "./nav-menus";
import { logout } from "../login/actions";
import { can, type Capability, type Role } from "@/lib/auth/capabilities";
import { Badge } from "./ui";

/**
 * Every link carries the capability that gates its page, so the nav and the page guard
 * are driven by the same map in `lib/auth/capabilities.ts`. A link the user can't follow
 * simply isn't rendered — and because the page guards independently, hiding the link is
 * presentation rather than the security boundary.
 *
 * ⚠️ **Every page must render this component.** The Overview page used to hand-roll its own
 * header instead, and because that copy had no link list, `/` had no navigation at all —
 * which is where `landingPathFor` sends every admin and viewer, so the default landing page
 * was a dead end you could only scroll. It went unnoticed because every other page had a
 * working nav and nobody arrives at `/` by clicking. If you add a page, use `<Nav>`; if you
 * need something in the header, add it here rather than forking the markup.
 *
 * ## Why this is grouped rather than a flat row
 *
 * Sixteen top-level links overflowed the header and put a horizontal scrollbar on every page
 * in the app — the worst kind of layout bug, because the thing that scrolls is the document,
 * so it appears at the very bottom, miles from the nav that caused it.
 *
 * Grouping is not just a width fix. A flat list of sixteen gives no hint that Social,
 * Creatives, Audience, Journeys and Content are five views of one question; the groups say
 * what belongs with what.
 *
 * ## How the groups are decided
 *
 * By what a person is trying to do, not by which table the data lives in. Two consequences
 * that were previously wrong:
 *
 * **Costs, Shipping and Team are settings, not analysis.** They are places you go to *enter*
 * something. Team in particular sat under "Forecast", which is simply a filing error — it is
 * there because Forecast happened to be the last group when Team was added.
 *
 * **One door per job.** "Forecast & goals" and "Goal planner" were two nav entries for setting
 * the same targets, which forces a choice nobody has the information to make. Forecast is now
 * the single entry, and it links to the planner where targets are actually being set. The
 * planner keeps its own route rather than being merged in, because its whole design is that
 * the URL *is* the plan — bookmark a scenario, open two tabs to compare, paste one to someone
 * else. Folding it into a page that owns different search params would break that.
 *
 * ## Menu behaviour lives in `nav-menus.tsx`
 *
 * This component decides *what* is in the nav; that one handles opening and closing. It is a
 * Client Component because the previous `<details>`-based version left every menu you opened
 * hanging open, and they overlap into an unreadable stack. See the note there.
 */

interface NavLink {
  href: string;
  label: string;
  capability?: Capability;
}

interface NavGroup {
  /** Shown on the menu button. */
  label: string;
  /** A group with one link renders as a plain link — no menu around a single item. */
  links: NavLink[];
}

const GROUPS: NavGroup[] = [
  // No capability: every role may ask questions. What differs is the toolset the agent
  // is given, which is derived from this same map — see lib/ai/tools.server.ts.
  { label: "Ask", links: [{ href: "/ask", label: "Ask", capability: undefined }] },
  {
    label: "Overview",
    links: [
      { href: "/", label: "Overview", capability: "revenue" },
      // No capability. Everyone reading a number needs to know how old it is, and gating this
      // would let a viewer trust a figure an admin could see was three days stale.
      { href: "/data", label: "Data updates", capability: undefined },
      // Sits under Overview because that is where the banner pointing at it lives.
      { href: "/review", label: "Orders to review", capability: "revenue" },
      // No capability: knowing what is outstanding is not privileged, and each item links to
      // a page that guards itself.
      { href: "/todo", label: "What's outstanding", capability: undefined },
    ],
  },
  {
    label: "Marketing",
    links: [
      { href: "/marketing", label: "Overview", capability: "marketing" },
      { href: "/creatives", label: "Campaigns & creatives", capability: "marketing" },
      { href: "/journeys", label: "Attribution coverage", capability: "marketing" },
      // The three organic/owned-audience views, kept adjacent. "Journeys" was renamed
      // because the page is a coverage report — what attribution can and cannot see — and
      // the old name promised a path explorer it deliberately isn't.
      { href: "/social", label: "Social", capability: "marketing" },
      { href: "/audience", label: "Audience growth", capability: "marketing" },
      { href: "/content", label: "Content & readership", capability: "marketing" },
    ],
  },
  {
    label: "Customers",
    links: [
      { href: "/customers", label: "Customers & LTV", capability: "customers" },
      { href: "/churn", label: "Churn & cohorts", capability: "audience" },
      { href: "/personas", label: "Personas", capability: "audience" },
    ],
  },
  {
    label: "Profit",
    links: [
      { href: "/profit", label: "Profit", capability: "margin" },
      { href: "/discounts", label: "Discount codes", capability: "margin" },
      { href: "/international", label: "International margin", capability: "margin" },
    ],
  },
  // One entry, not two. The goal planner is reached from the targets card on /forecast,
  // where you are already deciding what a target should be — see the note at the top.
  {
    label: "Forecast",
    links: [{ href: "/forecast", label: "Forecast & goals", capability: "revenue" }],
  },
  // Places you go to enter something rather than to read something. Team was filed under
  // Forecast, which was an accident of when it was added rather than a decision.
  {
    label: "Settings",
    links: [
      { href: "/costs", label: "Costs & COGS", capability: "settings" },
      { href: "/shipping", label: "Shipping costs", capability: "settings" },
      { href: "/team", label: "Team & access", capability: "team" },
    ],
  },
];

/**
 * Async because it carries the automatic data refresh.
 *
 * The refresh lives HERE rather than on each page for the same reason the link list does:
 * every page renders Nav, so putting it here means no page can accidentally omit it. A page
 * that forgot would silently never refresh, and nothing would report that.
 *
 * It costs one cheap aggregate over sync_runs per render. See lib/sync/auto-refresh.server.ts
 * for the four gates that stop a page view turning into a sync.
 */
export async function Nav({ email, role }: { email: string; role: Role }) {
  const initial = email.charAt(0).toUpperCase();
  const refresh = await getRefreshState();

  // Filter inside each group first, then drop groups that are left empty — otherwise a role
  // with no margin capability gets an empty "Profit" menu that opens onto nothing.
  const visible = GROUPS.map((g) => ({
    ...g,
    links: g.links.filter((l) => !l.capability || can(role, l.capability)),
  })).filter((g) => g.links.length > 0);

  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight">Esses Analytics</span>
            {/* Moved here from the Overview page's own header when that header was deleted
                in favour of this component — see the note at the top of the file. */}
            <Badge>internal</Badge>
          </span>
          {/* The capability filter runs here, on the server, so a link a role cannot follow
              never reaches the browser. NavMenus receives only the labels and hrefs it should
              render — the capability values are deliberately not serialised to the client. */}
          <NavMenus
            groups={visible.map((g) => ({
              label: g.label,
              links: g.links.map((l) => ({ href: l.href, label: l.label })),
            }))}
          />
        </div>
        <div className="flex items-center gap-3">
          <AutoRefresh
            stale={refresh.decision.refresh}
            inFlight={refresh.inFlight}
            lastFinishedAt={refresh.lastFinishedAt}
          />
          {/* The account link lives here rather than in the main nav: everyone needs it,
              but it isn't a dashboard. */}
          <Link href="/account" className="text-right hover:opacity-80">
            <div className="text-sm text-neutral-700 dark:text-neutral-300">{email}</div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">{role}</div>
          </Link>
          <Link
            href="/account"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-sm font-medium text-white transition hover:opacity-90 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {initial}
          </Link>
          <form action={logout}>
            <button
              type="submit"
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

export { Badge };

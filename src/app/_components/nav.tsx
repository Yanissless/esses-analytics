import Link from "next/link";
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
 * Grouping to six top-level items is not just a width fix. A flat list of sixteen gives no
 * hint that Social, Creatives, Audience and Journeys are four views of one question; the
 * groups say what belongs with what.
 *
 * ## Why `<details>` and not a JS menu
 *
 * Same reasoning as the campaign drill-down on `/creatives`: no JavaScript means it cannot
 * break on hydration, and `<details>`/`<summary>` is keyboard-operable and screen-reader
 * announced for free. A hover-only CSS menu would be neither — `visibility: hidden` takes its
 * links out of the tab order, so a keyboard user could never reach them.
 *
 * The trade-off is that a menu stays open until dismissed. For an internal tool that is worth
 * the robustness.
 */

interface NavLink {
  href: string;
  label: string;
  capability?: Capability;
}

interface NavGroup {
  /** Shown on the summary. */
  label: string;
  /** A group with one link renders as a plain link — no menu around a single item. */
  links: NavLink[];
}

const GROUPS: NavGroup[] = [
  // No capability: every role may ask questions. What differs is the toolset the agent
  // is given, which is derived from this same map — see lib/ai/tools.server.ts.
  { label: "Ask", links: [{ href: "/ask", label: "Ask", capability: undefined }] },
  { label: "Overview", links: [{ href: "/", label: "Overview", capability: "revenue" }] },
  {
    label: "Marketing",
    links: [
      { href: "/marketing", label: "Overview", capability: "marketing" },
      { href: "/creatives", label: "Campaigns & creatives", capability: "marketing" },
      { href: "/social", label: "Social", capability: "marketing" },
      { href: "/audience", label: "Audience growth", capability: "marketing" },
      { href: "/journeys", label: "Journeys", capability: "marketing" },
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
      { href: "/costs", label: "Costs", capability: "settings" },
      { href: "/shipping", label: "Shipping", capability: "settings" },
    ],
  },
  {
    label: "Forecast",
    links: [
      { href: "/forecast", label: "Forecast & goals", capability: "revenue" },
      { href: "/goals", label: "Goal planner", capability: "revenue" },
      { href: "/team", label: "Team", capability: "team" },
    ],
  },
];

const ITEM_CLASS =
  "rounded-lg px-2.5 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 " +
  "hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 " +
  "dark:hover:text-neutral-100";

function GroupMenu({ group }: { group: NavGroup }) {
  // Single-link groups render bare. A disclosure triangle around one item is friction with
  // nothing behind it, and it happens naturally whenever a role can see only one page in a
  // group — so this is a real case, not a stylistic one.
  if (group.links.length === 1) {
    return (
      <Link href={group.links[0].href} className={ITEM_CLASS}>
        {group.label}
      </Link>
    );
  }

  return (
    <details className="relative">
      <summary
        className={`${ITEM_CLASS} cursor-pointer list-none whitespace-nowrap marker:content-none`}
      >
        {group.label}
        <span aria-hidden className="ml-1 text-[10px] text-neutral-400">
          ▾
        </span>
      </summary>
      {/* Absolutely positioned so opening a menu doesn't reflow the header and shove the
          page content down — which is what made the original overflow so disorienting. */}
      <div className="absolute left-0 top-full z-20 mt-1 min-w-[14rem] rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
        {group.links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="block rounded-lg px-3 py-2 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </details>
  );
}

export function Nav({ email, role }: { email: string; role: Role }) {
  const initial = email.charAt(0).toUpperCase();

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
          {/* flex-wrap is a backstop: if this ever outgrows the header again it wraps to a
              second line instead of putting a scrollbar on the whole document. */}
          <nav className="flex flex-wrap items-center gap-1">
            {visible.map((g) => (
              <GroupMenu key={g.label} group={g} />
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
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

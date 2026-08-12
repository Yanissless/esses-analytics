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
 */
const LINKS: Array<{ href: string; label: string; capability?: Capability }> = [
  // No capability: every role may ask questions. What differs is the toolset the agent
  // is given, which is derived from this same map — see lib/ai/tools.server.ts.
  { href: "/ask", label: "Ask", capability: undefined },
  { href: "/", label: "Overview", capability: "revenue" },
  { href: "/profit", label: "Profit", capability: "margin" },
  { href: "/marketing", label: "Marketing", capability: "marketing" },
  { href: "/social", label: "Social", capability: "marketing" },
  { href: "/audience", label: "Audience", capability: "marketing" },
  { href: "/journeys", label: "Journeys", capability: "marketing" },
  { href: "/customers", label: "Customers & LTV", capability: "customers" },
  { href: "/churn", label: "Churn & cohorts", capability: "audience" },
  { href: "/personas", label: "Personas", capability: "audience" },
  { href: "/forecast", label: "Forecast", capability: "revenue" },
  { href: "/international", label: "International margin", capability: "margin" },
  { href: "/costs", label: "Costs", capability: "settings" },
  { href: "/shipping", label: "Shipping", capability: "settings" },
  { href: "/team", label: "Team", capability: "team" },
];

export function Nav({ email, role }: { email: string; role: Role }) {
  const initial = email.charAt(0).toUpperCase();
  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight">Esses Analytics</span>
            {/* Moved here from the Overview page's own header when that header was deleted
                in favour of this component — see the note at the top of the file. */}
            <Badge>internal</Badge>
          </span>
          <nav className="flex items-center gap-1">
            {LINKS.filter((l) => !l.capability || can(role, l.capability)).map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-lg px-2.5 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                {l.label}
              </Link>
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

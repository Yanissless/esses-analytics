import Link from "next/link";
import { logout } from "../login/actions";
import { Badge } from "./ui";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/profit", label: "Profit" },
  { href: "/marketing", label: "Marketing" },
  { href: "/social", label: "Social" },
  { href: "/customers", label: "Customers & LTV" },
  { href: "/churn", label: "Churn & cohorts" },
  { href: "/personas", label: "Personas" },
  { href: "/forecast", label: "Forecast" },
  { href: "/international", label: "International margin" },
  { href: "/costs", label: "Costs", adminOnly: true },
  { href: "/shipping", label: "Shipping", adminOnly: true },
];

export function Nav({ email, role }: { email: string; role: string }) {
  const initial = email.charAt(0).toUpperCase();
  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold tracking-tight">Esses Analytics</span>
          <nav className="flex items-center gap-1">
            {LINKS.filter((l) => !l.adminOnly || role === "admin").map((l) => (
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
          <div className="text-right">
            <div className="text-sm text-neutral-700 dark:text-neutral-300">{email}</div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">{role}</div>
          </div>
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
            {initial}
          </div>
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

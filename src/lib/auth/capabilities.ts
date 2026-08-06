/**
 * What each role is allowed to see and do.
 *
 * ## Why capabilities rather than role checks
 *
 * Before this, every page called either `requireUser()` or `requireAdmin()`, and the nav
 * filtered on a boolean `adminOnly`. Adding a third role that way would mean a role
 * comparison scattered across seventeen routes — exactly the copy-paste-then-drift
 * pattern that has already produced two live bugs in this codebase (the `revenue_class`
 * CASE and the shipping rate-rule predicate). A page that forgot to be updated would
 * silently leak data rather than merely miscalculate.
 *
 * So access is expressed once, here, as a map from role to capability. Pages ask for a
 * capability; the nav filters on the same map. Adding a role means editing one object.
 *
 * ## What the `marketing` role can and cannot see
 *
 * "Marketing only" cannot mean "no revenue" — MER and ROAS are revenue divided by spend,
 * so they're meaningless without it. The boundary that *is* coherent:
 *
 *  - **Allowed:** aggregate revenue in a marketing context, channel and campaign
 *    performance, cohort-level LTV and retention. All of it is needed to judge whether
 *    acquisition is working.
 *  - **Withheld:** cost and margin (COGS, CM1–CM3, per-market profit), and any
 *    individual customer record — names, emails, per-person lifetime value.
 *
 * ⚠️ This module must stay dependency-free: the nav imports it, and pulling in the DB
 * client would break the client bundle (see `margin-boundary.ts` for the same note).
 */

export type Role = "admin" | "viewer" | "marketing";

export const ROLES: Role[] = ["admin", "viewer", "marketing"];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as string[]).includes(v);
}

export type Capability =
  /** Channel and campaign performance: /marketing, /social. */
  | "marketing"
  /** Cohort-level audience analysis, no individual records: /personas, /churn. */
  | "audience"
  /** Aggregate revenue and goals outside a marketing frame: /, /forecast. */
  | "revenue"
  /** Cost and margin: /profit, /international, /costs, /shipping. */
  | "margin"
  /** Individual customer records, including names and emails: /customers. */
  | "customers"
  /** Write access to costs, the margin boundary, goals, shipping imports. */
  | "settings"
  /** Adding, removing and re-roling people. */
  | "team";

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  // Everything, including writes.
  admin: ["marketing", "audience", "revenue", "margin", "customers", "settings", "team"],
  // Every read, no writes — unchanged from before this module existed.
  viewer: ["marketing", "audience", "revenue", "margin", "customers"],
  // Acquisition performance and cohort analysis. No margin, no individual customers.
  marketing: ["marketing", "audience"],
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Where a role should land after signing in.
 *
 * The Overview page carries CM3 and a top-customers table with email addresses, so a
 * marketing user is sent to /marketing instead. Redirecting away from a page is
 * deliberately preferred over hiding sections within it: if a section is missed, the
 * failure is a silent data leak, whereas a wrong redirect is merely annoying.
 */
export function landingPathFor(role: Role): string {
  return can(role, "revenue") ? "/" : "/marketing";
}

export interface RoleMeta {
  id: Role;
  label: string;
  /** One line for the invite form. */
  summary: string;
  /** What this role is explicitly NOT shown, for the Team page. */
  withheld: string | null;
}

export const ROLE_META: Record<Role, RoleMeta> = {
  admin: {
    id: "admin",
    label: "Admin",
    summary: "Everything, and can edit costs, goals and people.",
    withheld: null,
  },
  viewer: {
    id: "viewer",
    label: "Viewer",
    summary: "Sees everything, changes nothing.",
    withheld: null,
  },
  marketing: {
    id: "marketing",
    label: "Marketing",
    summary: "Channel, campaign and cohort performance. Read-only.",
    withheld:
      "Cost and margin (COGS, CM1–CM3, per-market profit), and individual customer records including names and emails.",
  },
};

/**
 * What the session wall does with a request, as a pure decision.
 *
 * Extracted from `src/proxy.ts` so it can be tested. The proxy itself has to build a real
 * `NextRequest` and reach into `next/server`, and the alias it imports through (`@/…`) isn't
 * resolvable under vitest — so as long as the rule lived inline, the auth wall was the one
 * security boundary in the app with no tests behind it.
 *
 * Same split as `lib/sync/auto-refresh.server.ts`: the decision is a function of facts, and the
 * caller does the IO. Here the only facts are the path and whether a session verified.
 */

/** Paths the session wall does NOT guard. */
export const PUBLIC_PATHS = ["/login", "/api/health", "/api/sync"] as const;

export function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export type WallOutcome =
  /** Let it through. */
  | { kind: "allow" }
  /** Signed in and asking for /login — send them to the dashboard. */
  | { kind: "redirect-home" }
  /** A browser navigating without a session. Send it to the login page. */
  | { kind: "redirect-login"; next: string | null }
  /** A fetch without a session. Needs a status code, not a page. */
  | { kind: "unauthorized" };

/**
 * The rule, in one place.
 *
 * The case worth stating is the last one. A 307 to /login is right for a browser NAVIGATING to
 * a page, and wrong for a fetch: the caller is JavaScript expecting JSON and it receives the
 * login page's HTML instead. That surfaced through the automatic refresh — an expired session
 * made `response.json()` throw, so the indicator said "Couldn't update data" when the truth was
 * "you are signed out". A misleading error costs more than an honest one, because it sends
 * someone looking for a data problem that doesn't exist.
 *
 * Both branches refuse the request. Only the shape of the refusal differs, so this is a
 * usability fix and not a loosening of the wall.
 */
export function wallOutcome(pathname: string, hasSession: boolean): WallOutcome {
  if (hasSession) {
    return pathname === "/login" ? { kind: "redirect-home" } : { kind: "allow" };
  }

  if (isPublic(pathname)) return { kind: "allow" };

  if (pathname.startsWith("/api/")) return { kind: "unauthorized" };

  // `next` is omitted for the root so a bounced visitor lands on a clean /login URL.
  return { kind: "redirect-login", next: pathname === "/" ? null : pathname };
}

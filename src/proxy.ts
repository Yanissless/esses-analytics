import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { wallOutcome } from "@/lib/auth/wall";

/**
 * Auth wall for the entire app (Section 10). Everything requires a valid session
 * except the login page and the health check. "Hidden by URL" is not enough — a
 * real login gate runs on every request here.
 *
 * (Next 16 renamed the `middleware` convention to `proxy`; same behaviour.)
 *
 * The rule itself lives in `lib/auth/wall.ts` as a pure function so it can be tested. This file
 * is only the translation from decision to HTTP response — including the one distinction that
 * matters in practice: an unauthenticated API request gets a 401 it can act on, not a redirect
 * to a page it cannot parse.
 *
 * `/api/sync` is public HERE and not actually public: a scheduler has no user to log in as, so
 * it authenticates with a shared secret instead of a session. It's listed as public so the proxy
 * doesn't redirect the scheduler to /login; the route itself refuses any request without a valid
 * `CRON_SECRET`, and refuses every request when that secret is unset.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  const outcome = wallOutcome(pathname, session !== null);

  switch (outcome.kind) {
    case "allow":
      return NextResponse.next();

    case "redirect-home": {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }

    case "redirect-login": {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.search = outcome.next ? `?next=${encodeURIComponent(outcome.next)}` : "";
      return NextResponse.redirect(url);
    }

    case "unauthorized":
      return NextResponse.json(
        { error: "Not signed in.", signedOut: true },
        { status: 401 },
      );
  }
}

export const config = {
  // Run on everything except Next internals and static asset files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

/**
 * Server-only helpers to read the current session and guard server components /
 * server actions. Uses next/headers, so never import this from Edge middleware
 * (middleware reads the cookie from the request directly).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./session";

export async function getCurrentUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/**
 * Redirect to /login if not authenticated, or if the account has since been
 * deactivated. Role is re-read from the database rather than trusted from the cookie.
 *
 * Sessions are stateless 7-day JWTs, so revoking access by setting `is_active = false`
 * would otherwise leave that person signed in for up to a week — not acceptable for a
 * tool holding real financial data that's about to be shared with a team. Same for a
 * demotion from admin to viewer: without this it wouldn't take effect until the cookie
 * expired.
 *
 * Costs one primary-key lookup per page render, which is negligible beside the
 * analytics queries these pages already run.
 */
export async function requireUser(): Promise<SessionPayload> {
  const session = await getCurrentUser();
  if (!session) redirect("/login");

  const [row] = await db
    .select({ isActive: users.isActive, role: users.role, name: users.name })
    .from(users)
    .where(eq(users.id, session.sub))
    .limit(1);

  if (!row || !row.isActive) redirect("/login?revoked=1");

  return { ...session, role: row.role, name: row.name ?? session.name };
}

/** Redirect viewers away from admin-only surfaces. */
export async function requireAdmin(): Promise<SessionPayload> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}

/**
 * Server-only helpers to read the current session and guard server components /
 * server actions. Uses next/headers, so never import this from Edge middleware
 * (middleware reads the cookie from the request directly).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./session";

export async function getCurrentUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/** Redirect to /login if not authenticated. */
export async function requireUser(): Promise<SessionPayload> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Redirect viewers away from admin-only surfaces. */
export async function requireAdmin(): Promise<SessionPayload> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}

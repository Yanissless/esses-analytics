/**
 * Stateless signed-cookie sessions (jose HS256).
 *
 * This module is EDGE-SAFE: it uses only jose (Web Crypto) and reads AUTH_SECRET
 * directly from process.env, so it works in middleware as well as server code.
 * Do NOT import the full env schema here (see src/lib/env.ts for why).
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "esses_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

/** Re-exported from capabilities.ts so there's one definition of the role set. */
export type { Role } from "./capabilities";
import { isRole, type Role } from "./capabilities";

export interface SessionPayload {
  sub: string; // user id
  email: string;
  role: Role;
  name?: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role, name: payload.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(getSecret());
}

export async function verifySession(
  token: string | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
    });
    const role = payload.role;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      !isRole(role)
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      email: payload.email,
      role,
      name: typeof payload.name === "string" ? payload.name : undefined,
    };
  } catch {
    return null;
  }
}

/** Shared cookie options for set/clear. */
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

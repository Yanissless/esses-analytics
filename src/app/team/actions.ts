"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { requireAdmin, requireUser } from "@/lib/auth/current-user";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

export type TeamActionState = { error?: string; ok?: string; tempPassword?: string };

/** Long enough to be safe as a one-time credential, short enough to read aloud. */
function generateTempPassword(): string {
  return randomBytes(12).toString("base64url");
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

/** Admins remaining if `excludingUserId` were removed or demoted. */
async function otherActiveAdmins(excludingUserId: string): Promise<number> {
  const [r] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(eq(users.role, "admin"), eq(users.isActive, true), ne(users.id, excludingUserId)),
    )) as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

/**
 * Add a teammate and return a one-time password.
 *
 * There's no mail sending configured, so the password is shown to the admin **once**
 * and has to be passed on out of band. That's a deliberate trade: an invite-email flow
 * needs Mailgun wired up and a token table, and this unblocks the team today. The new
 * user should change it immediately via /account.
 */
export async function inviteUser(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  await requireAdmin();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "viewer");

  if (!EMAIL.test(email)) return { error: "That doesn't look like an email address." };
  if (role !== "admin" && role !== "viewer") return { error: "Role must be admin or viewer." };

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    return {
      error: existing.isActive
        ? `${email} already has an account.`
        : `${email} exists but is deactivated — reactivate them instead of re-inviting.`,
    };
  }

  const tempPassword = generateTempPassword();
  await db.insert(users).values({
    email,
    name: name || null,
    passwordHash: await hashPassword(tempPassword),
    role,
    isActive: true,
  });

  revalidatePath("/team");
  return {
    ok: `Added ${email} as ${role}.`,
    tempPassword,
  };
}

/** Promote or demote. Refuses to remove the last admin, and refuses self-demotion. */
export async function setUserRole(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const me = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");

  if (role !== "admin" && role !== "viewer") return { error: "Role must be admin or viewer." };
  if (!userId) return { error: "Missing user." };

  if (userId === me.sub && role === "viewer") {
    // Self-demotion is the fastest way to lock yourself out of the admin surfaces.
    return { error: "You can't demote yourself — ask another admin to do it." };
  }
  if (role === "viewer" && (await otherActiveAdmins(userId)) === 0) {
    return { error: "That's the only admin left. Promote someone else first." };
  }

  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { error: "User not found." };

  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
  revalidatePath("/team");
  return { ok: `${target.email} is now ${role}.` };
}

/**
 * Activate or deactivate. Deactivation takes effect immediately, because
 * `requireUser()` re-checks `is_active` on every page render rather than trusting the
 * session cookie.
 */
export async function setUserActive(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const me = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";

  if (!userId) return { error: "Missing user." };
  if (userId === me.sub && !active) {
    return { error: "You can't deactivate your own account." };
  }
  if (!active && (await otherActiveAdmins(userId)) === 0) {
    const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (target?.role === "admin") {
      return { error: "That's the only admin left. Promote someone else first." };
    }
  }

  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { error: "User not found." };

  await db
    .update(users)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(users.id, userId));
  revalidatePath("/team");
  return {
    ok: active
      ? `${target.email} reactivated.`
      : `${target.email} deactivated — signed out immediately.`,
  };
}

/** Issue a new one-time password for someone who's locked out. */
export async function resetUserPassword(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { error: "Missing user." };

  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { error: "User not found." };

  const tempPassword = generateTempPassword();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(tempPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));

  revalidatePath("/team");
  return { ok: `New one-time password for ${target.email}.`, tempPassword };
}

/**
 * Change your own password. Requires the current one, so a borrowed session can't be
 * used to take over the account.
 */
export async function changeOwnPassword(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const me = await requireUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!current || !next) return { error: "Fill in both fields." };
  if (next !== confirm) return { error: "The new passwords don't match." };
  if (next.length < MIN_PASSWORD) {
    return { error: `Use at least ${MIN_PASSWORD} characters.` };
  }
  if (next === current) return { error: "That's the password you already have." };

  const [row] = await db.select().from(users).where(eq(users.id, me.sub)).limit(1);
  if (!row) return { error: "Account not found." };
  if (!(await verifyPassword(current, row.passwordHash))) {
    return { error: "Current password is incorrect." };
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next), updatedAt: new Date() })
    .where(eq(users.id, me.sub));

  return { ok: "Password changed." };
}

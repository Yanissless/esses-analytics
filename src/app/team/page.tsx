import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import { Card } from "../_components/ui";
import { Nav } from "../_components/nav";
import { ChangePasswordForm, InviteForm, MemberRow } from "./forms";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const me = await requireAdmin();
  const rows = await db.select().from(users).orderBy(asc(users.email));

  const active = rows.filter((r) => r.isActive);
  const admins = active.filter((r) => r.role === "admin");

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={me.email} role={me.role} />
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Team</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            {active.length} active {active.length === 1 ? "person" : "people"} · {admins.length}{" "}
            {admins.length === 1 ? "admin" : "admins"}
          </p>
        </div>

        <div className="rounded-xl border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          <strong>Viewers see everything; admins can also change things.</strong> Every page — including
          revenue, margin and customer data — is visible to both roles. The admin difference is
          write access: editing costs, the margin boundary, goals, shipping imports and this page.
          There is no read-only-subset role, so only add people who should see the whole picture.
        </div>

        <Card
          title="Add a teammate"
          subtitle="Creates the account and shows a one-time password — there's no invite email yet, so you'll need to pass it on yourself"
        >
          <InviteForm />
        </Card>

        <Card title="People" subtitle="Deactivating someone signs them out immediately">
          <div>
            {rows.map((r) => (
              <MemberRow
                key={r.id}
                member={{
                  id: r.id,
                  email: r.email,
                  name: r.name,
                  role: r.role,
                  isActive: r.isActive,
                  lastLoginAt: r.lastLoginAt
                    ? new Date(r.lastLoginAt).toISOString().slice(0, 16).replace("T", " ")
                    : null,
                  isSelf: r.id === me.sub,
                }}
              />
            ))}
          </div>
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            You can&rsquo;t demote or deactivate yourself, and the last remaining admin is
            protected — otherwise it would be possible to lock everyone out of the settings.
          </p>
        </Card>

        <Card
          title="Your password"
          subtitle="Anyone can change their own; admins can issue a reset for someone else above"
        >
          <ChangePasswordForm />
        </Card>
      </main>
    </div>
  );
}

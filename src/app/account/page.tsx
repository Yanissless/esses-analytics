import { requireUser } from "@/lib/auth/current-user";
import { Card } from "../_components/ui";
import { Nav } from "../_components/nav";
import { ChangePasswordForm } from "../team/forms";

export const dynamic = "force-dynamic";

/**
 * Own-account settings for everyone. Exists separately from `/team` because that page
 * is admin-only, and a viewer given a one-time password still has to be able to change
 * it — otherwise the temporary credential becomes permanent.
 */
export default async function AccountPage() {
  const user = await requireUser();

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Account</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            {user.name ? `${user.name} · ` : ""}
            {user.email} · {user.role}
          </p>
        </div>

        <Card
          title="Change your password"
          subtitle="If you were given a one-time password, change it now"
        >
          <ChangePasswordForm />
        </Card>
      </main>
    </div>
  );
}

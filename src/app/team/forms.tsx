"use client";

import { useActionState } from "react";
import {
  changeOwnPassword,
  inviteUser,
  resetUserPassword,
  setUserActive,
  setUserRole,
  type TeamActionState,
} from "./actions";

const initial: TeamActionState = {};

const input =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const label = "mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400";
const button =
  "rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900";
const subtle =
  "rounded-lg border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

/**
 * A one-time password, shown once because there's no mail sending configured.
 * Deliberately prominent — if the admin misses it, the only recovery is another reset.
 */
function TempPassword({ value }: { value: string }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
      <p className="font-medium text-amber-900 dark:text-amber-200">
        One-time password — copy it now, it won&rsquo;t be shown again
      </p>
      <code className="mt-1 block break-all rounded bg-white px-2 py-1 font-mono text-sm text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {value}
      </code>
      <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
        Send it to them over something other than email if you can, and ask them to change it
        under <strong>Account</strong> as soon as they&rsquo;re in.
      </p>
    </div>
  );
}

function Msg({ state }: { state: TeamActionState }) {
  return (
    <>
      {state.ok || state.error ? (
        <div className="mt-3 space-y-1 text-sm">
          {state.ok ? <p className="text-emerald-600 dark:text-emerald-400">{state.ok}</p> : null}
          {state.error ? <p className="text-red-600 dark:text-red-400">{state.error}</p> : null}
        </div>
      ) : null}
      {state.tempPassword ? <TempPassword value={state.tempPassword} /> : null}
    </>
  );
}

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteUser, initial);
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="invite-email">
            Email
          </label>
          <input id="invite-email" name="email" className={input} placeholder="name@essesmag.com" />
        </div>
        <div>
          <label className={label} htmlFor="invite-name">
            Name (optional)
          </label>
          <input id="invite-name" name="name" className={input} />
        </div>
        <div>
          <label className={label} htmlFor="invite-role">
            Role
          </label>
          <select id="invite-role" name="role" className={input} defaultValue="viewer">
            <option value="viewer">Viewer — read everything</option>
            <option value="admin">Admin — can also edit costs and goals</option>
          </select>
        </div>
      </div>
      <button type="submit" className={button} disabled={pending}>
        {pending ? "Adding…" : "Add teammate"}
      </button>
      <Msg state={state} />
    </form>
  );
}

export interface TeamMember {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  isSelf: boolean;
}

export function MemberRow({ member }: { member: TeamMember }) {
  const [roleState, roleAction, rolePending] = useActionState(setUserRole, initial);
  const [activeState, activeAction, activePending] = useActionState(setUserActive, initial);
  const [resetState, resetAction, resetPending] = useActionState(resetUserPassword, initial);

  const state = resetState.tempPassword
    ? resetState
    : roleState.error || roleState.ok
      ? roleState
      : activeState.error || activeState.ok
        ? activeState
        : resetState;

  return (
    <div className="border-b border-neutral-100 py-3 last:border-0 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{member.name ?? member.email}</span>
            {member.isSelf ? (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                you
              </span>
            ) : null}
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                member.role === "admin"
                  ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {member.role}
            </span>
            {!member.isActive ? (
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-800 dark:bg-red-950 dark:text-red-300">
                deactivated
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            {member.name ? `${member.email} · ` : ""}
            {member.lastLoginAt ? `last signed in ${member.lastLoginAt}` : "never signed in"}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={roleAction}>
            <input type="hidden" name="userId" value={member.id} />
            <input
              type="hidden"
              name="role"
              value={member.role === "admin" ? "viewer" : "admin"}
            />
            <button type="submit" className={subtle} disabled={rolePending}>
              {member.role === "admin" ? "Make viewer" : "Make admin"}
            </button>
          </form>

          <form action={resetAction}>
            <input type="hidden" name="userId" value={member.id} />
            <button type="submit" className={subtle} disabled={resetPending}>
              {resetPending ? "Resetting…" : "Reset password"}
            </button>
          </form>

          <form action={activeAction}>
            <input type="hidden" name="userId" value={member.id} />
            <input type="hidden" name="active" value={member.isActive ? "false" : "true"} />
            <button type="submit" className={subtle} disabled={activePending}>
              {member.isActive ? "Deactivate" : "Reactivate"}
            </button>
          </form>
        </div>
      </div>
      <Msg state={state} />
    </div>
  );
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changeOwnPassword, initial);
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="pw-current">
            Current password
          </label>
          <input id="pw-current" name="current" type="password" className={input} />
        </div>
        <div>
          <label className={label} htmlFor="pw-next">
            New password
          </label>
          <input id="pw-next" name="next" type="password" className={input} />
        </div>
        <div>
          <label className={label} htmlFor="pw-confirm">
            Confirm new password
          </label>
          <input id="pw-confirm" name="confirm" type="password" className={input} />
        </div>
      </div>
      <button type="submit" className={button} disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </button>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        At least 12 characters. Changing it doesn&rsquo;t sign you out of other devices — sessions
        last 7 days.
      </p>
      <Msg state={state} />
    </form>
  );
}

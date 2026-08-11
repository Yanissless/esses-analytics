/**
 * Deep Meta diagnostic.
 *
 *   run.cmd check:meta
 *
 * `check:ads` answers "can I sync?". This answers "why not, and what do I do about it?" —
 * it separates a bad token from a blocked app from a missing scope, which need completely
 * different fixes, and reports which permissions the token actually carries so a missing
 * one is found now rather than halfway through a backfill.
 *
 * Reads only. Makes no writes and starts no sync.
 */
import "dotenv/config";

const V = "v21.0";
const BASE = `https://graph.facebook.com/${V}`;

/** Scopes this app needs. `ads_read` today; the rest for the social engagement work. */
const REQUIRED_NOW = ["ads_read"];
const REQUIRED_FOR_SOCIAL = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
];

interface MetaError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
}

async function call<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; err: MetaError; status: number }> {
  const token = process.env.META_ACCESS_TOKEN ?? "";
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}access_token=${encodeURIComponent(token)}`);
  const body = (await res.json()) as { error?: MetaError } & T;
  if (body.error) return { ok: false, err: body.error, status: res.status };
  return { ok: true, data: body as T };
}

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(24)}${value}`);
}

/**
 * Distinguish a broken credential from a blocked app.
 *
 * Meta returns code 190 for anything wrong with the TOKEN itself (malformed, expired,
 * revoked) and code 200 for permission/app-level refusals. Comparing our token against a
 * deliberately malformed one is what proved the block was on the app rather than the
 * credential — a fresh token from the same app fails identically, so generating one is
 * wasted effort until the app is fixed.
 */
async function differentialTest(): Promise<"token" | "app" | "ok"> {
  const ours = await call<{ id?: string }>("/me?fields=id");
  if (ours.ok) return "ok";

  const code = ours.err.code;
  console.log(`  /me failed: HTTP ${ours.status}  code=${code}  ${ours.err.message}`);

  if (code === 190) return "token";
  if (code === 200 || code === 10 || code === 3) return "app";
  return "app";
}

async function main() {
  const token = process.env.META_ACCESS_TOKEN ?? "";
  const acctRaw = process.env.META_AD_ACCOUNT_ID ?? "";
  const acct = acctRaw ? (acctRaw.startsWith("act_") ? acctRaw : `act_${acctRaw}`) : "";

  console.log("\nMeta access diagnostic\n");
  line("Token present", token ? `yes (${token.length} chars, starts ${token.slice(0, 6)}…)` : "NO");
  line("Ad account", acct || "NOT SET");
  console.log("");

  if (!token) {
    console.log("  META_ACCESS_TOKEN is not set. Nothing to diagnose.\n");
    process.exitCode = 1;
    return;
  }

  const verdict = await differentialTest();

  if (verdict === "token") {
    console.log(`
  DIAGNOSIS: the TOKEN is the problem (error code 190).

  It's malformed, expired or revoked — but the app itself is reachable. Generating a
  fresh token WILL fix this.

  Business Suite → Business Settings → Users → System Users → pick the system user →
  Generate new token → choose the app → tick 'ads_read' → copy it into META_ACCESS_TOKEN.

  Prefer a System User token: unlike a personal one it doesn't expire.
`);
    process.exitCode = 1;
    return;
  }

  if (verdict === "app") {
    console.log(`
  DIAGNOSIS: a Meta enforcement action on the APP or the BUSINESS. Not the token, and not
  anything you can fix by reconfiguring.

  Established 2026-08-10/11, so none of this needs re-testing:

    - The token is FINE. Meta's own debugger reports Valid: True. It is a System User
      token, it never expires, and it carries ads_read + read_insights.
        App:  Esses Analytics  (id 28698775013059115)
        User: esses analytics sync
    - NOT an API version sunset. Identical code 200 on v20.0 through v26.0, including the
      v26.0 the debugger itself uses, across /me, the ad account, insights, the app object
      and debug_token.
    - So a valid token with correct scopes is refused on every endpoint of every version.
      That is a blanket bar, i.e. enforcement.

  *** Do NOT generate a new token, and do NOT build a new app. The existing setup is
      already correct — a rebuild discards a good configuration and, if the block is at
      business level, hits the same wall. ***

  Fixing it needs Meta's UI, in this order. The order matters:

    1. Are you a registered Meta developer? On developers.facebook.com, the top right
       must read 'My Apps'. If it reads 'Get Started' you have never registered, and
       EVERY app URL will silently redirect you — including app creation. Register first;
       nothing else works until that button changes.

    2. Give yourself a role on the app, via the business rather than its original creator:
       business.facebook.com → Business Settings → Accounts → Apps → Esses Analytics →
       Add people → yourself as Administrator.
       If the app is NOT listed there it was never added to the Esses business, and only
       its creator can grant access.

    3. Now open developers.facebook.com/apps/28698775013059115/ and read the alert banner.
       Also check Settings → Advanced for an overdue Data Use Checkup (a common cause of
       exactly this error), and App Review → Permissions and Features for anything reverted
       to Standard Access.

    4. In parallel — this needs no developer registration and may answer it outright:
       business.facebook.com/accountquality  (Business Support Home). Restrictions and the
       appeal button live here, not in the developer dashboard.

    5. Search Meta email and notifications for 30 Jul - 4 Aug 2026. The only successful ads
       sync ran 2026-07-30; it was already blocked by 2026-08-04. Meta normally emails
       before restricting, and that email names the cause.
`);
    process.exitCode = 1;
    return;
  }

  // ---- Token works. Report what it actually is and carries. -----------------
  console.log("  /me succeeded — the token works.\n");

  const dbg = await call<{
    data?: {
      app_id?: string;
      application?: string;
      type?: string;
      expires_at?: number;
      data_access_expires_at?: number;
      is_valid?: boolean;
      scopes?: string[];
      granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
    };
  }>(`/debug_token?input_token=${encodeURIComponent(token)}`);

  const scopes = new Set<string>();
  if (dbg.ok && dbg.data.data) {
    const d = dbg.data.data;
    line("App", `${d.application ?? "unknown"} (id ${d.app_id ?? "unknown"})`);
    line("Token type", d.type ?? "unknown");
    line(
      "Expires",
      d.expires_at ? new Date(d.expires_at * 1000).toISOString().slice(0, 16) : "never (system user)",
    );
    if (d.data_access_expires_at) {
      line("Data access until", new Date(d.data_access_expires_at * 1000).toISOString().slice(0, 10));
    }
    for (const s of d.scopes ?? []) scopes.add(s);
    for (const g of d.granular_scopes ?? []) scopes.add(g.scope);
  } else {
    console.log("  (could not read /debug_token — scope list unavailable)");
  }
  console.log("");

  console.log("  Scopes needed now:");
  for (const s of REQUIRED_NOW) {
    console.log(`    ${scopes.has(s) ? "have" : "MISSING"}  ${s}`);
  }
  console.log("\n  Scopes for the social engagement dashboard (not needed for ads):");
  for (const s of REQUIRED_FOR_SOCIAL) {
    console.log(`    ${scopes.has(s) ? "have" : "missing"}  ${s}`);
  }
  console.log("");

  if (acct) {
    const a = await call<{ name?: string; account_status?: number; currency?: string; timezone_name?: string }>(
      `/${acct}?fields=name,account_status,currency,timezone_name`,
    );
    if (a.ok) {
      // account_status 1 = active. Anything else means Meta has restricted the account
      // itself, which is a different problem from a token or app issue.
      const status = a.data.account_status;
      line("Ad account", `${a.data.name} (${a.data.currency}, ${a.data.timezone_name})`);
      line("Account status", status === 1 ? "active" : `${status} — NOT active, check Billing`);
    } else {
      line("Ad account", `unreachable: ${a.err.message}`);
      console.log(
        "        ↳ The token works but this ad account doesn't. Assign it to the system\n" +
          "          user in Business Settings → Users → System Users → Assign Assets.",
      );
    }
  }

  const pages = await call<{ data?: Array<{ name?: string; instagram_business_account?: { id?: string } }> }>(
    "/me/accounts?fields=name,instagram_business_account",
  );
  console.log("");
  if (pages.ok) {
    const list = pages.data.data ?? [];
    line("Pages visible", String(list.length));
    for (const p of list) {
      console.log(
        `    ${p.name} — Instagram business account: ${p.instagram_business_account?.id ?? "not linked"}`,
      );
    }
    if (!list.length) {
      console.log(
        "        ↳ No Pages visible. Needed for Instagram insights later, not for ads.",
      );
    }
  } else {
    line("Pages", `not readable: ${pages.err.message}`);
  }

  const missingNow = REQUIRED_NOW.filter((s) => !scopes.has(s));
  console.log("");
  if (missingNow.length) {
    console.log(`  Add these scopes before syncing: ${missingNow.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  console.log("  Ready. Next: run.cmd backfill --since=2025-10-01 --source=ads, then run.cmd metrics\n");
  process.exitCode = 0;
  return;
}

main().catch((err) => {
  console.error("\nDiagnostic failed to run:", err instanceof Error ? err.message : err, "\n");
  process.exitCode = 1;
  return;
});

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
  DIAGNOSIS: the APP or the business is blocked, not the token (error code 200).

  A malformed token returns code 190; ours returns 200, which is Meta's permission and
  app-level family. Note that /debug_token normally answers even for EXPIRED tokens, so if
  that also fails the refusal is happening above the credential.

  *** A new token from the same app will fail in exactly the same way. Don't start there. ***

  Find out which app the token belongs to first — you cannot fix an app you can't locate:

    1. Go to  developers.facebook.com/tools/debug/accesstoken/
    2. Paste the token, click Debug.
       That page authenticates with YOUR Facebook login, not the token, so it usually
       reports the App name and App ID even when the API refuses the token.
    3. Note the App ID. If the app isn't listed under 'My Apps', you have no role on it —
       whoever created it must add you as an Administrator, or you create a new app.

  Then, on that app:
    - Read the alert banner at the top of its dashboard; Meta usually states the problem.
    - Settings → Advanced: complete any overdue Data Use Checkup. This is the single most
      common cause of this exact error, and it disables API access when it lapses.
    - App Review → Permissions and Features: look for anything reverted to Standard Access.
    - Check whether the app is in Development rather than Live mode. In Development only
      users with an explicit app role can call the API.
    - business.facebook.com → Business Settings → Security Centre: check Business
      Verification hasn't lapsed.

  If the app can't be found or recovered, starting fresh is usually faster than archaeology
  — see the 'clean rebuild' steps in HANDOFF.md section 5.2.
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

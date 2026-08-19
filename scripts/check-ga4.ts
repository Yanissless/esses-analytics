/**
 * Verify the GA4 connection, and name the specific mistake when it fails.
 *
 *   pnpm check:ga4
 *
 * Sam couldn't complete the GA4 setup first time round, and the reason is that it spans two
 * separate Google consoles where each console has a plausible-looking wrong answer sitting
 * next to the right one. Google's own error messages don't distinguish them: the same 403
 * comes back whether the service account was added to the wrong access list, added to a
 * different property, or the API was enabled in a different Cloud project.
 *
 * So this check does the distinguishing. Every failure below maps to one numbered step in
 * `docs/ga4-setup.md`, because "it doesn't work" is not something anyone can act on.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { env, connectorConfigured } from "../src/lib/env";

type Result = { ok: boolean; label: string; detail: string };
const results: Result[] = [];
const pass = (label: string, detail = "") => results.push({ ok: true, label, detail });
const fail = (label: string, detail: string) => results.push({ ok: false, label, detail });

async function main() {
  console.log("\nGoogle Analytics connection check\n");

  // ---- 1. Are both halves present at all? --------------------------------
  if (!env.GA4_PROPERTY_ID) {
    fail(
      "GA4_PROPERTY_ID",
      "Not set. It's the 9-10 digit number from Analytics → Admin → Property details.\n" +
        "     If what you have starts with 'G-', that's the Measurement ID — wrong one.\n" +
        "     See docs/ga4-setup.md step 2.2.",
    );
  } else {
    pass("GA4_PROPERTY_ID", env.GA4_PROPERTY_ID);
  }

  if (!env.GA4_CREDENTIALS_PATH) {
    fail(
      "GA4_CREDENTIALS_PATH",
      "Not set. Absolute path to the service-account JSON downloaded in step 1.5.",
    );
  } else {
    pass("GA4_CREDENTIALS_PATH", env.GA4_CREDENTIALS_PATH);
  }

  if (!connectorConfigured.ga4()) {
    report();
    console.log("Both values are needed. Walkthrough: docs/ga4-setup.md\n");
    process.exit(1);
  }

  // ---- 2. Is the key file readable, and actually a service-account key? ---
  let clientEmail = "";
  try {
    const raw = readFileSync(env.GA4_CREDENTIALS_PATH as string, "utf8");
    const key = JSON.parse(raw) as {
      type?: string;
      client_email?: string;
      project_id?: string;
      private_key?: string;
    };

    if (key.type !== "service_account") {
      fail(
        "Key file type",
        `Expected "service_account", got "${key.type ?? "(missing)"}". This looks like an OAuth\n` +
          "     client secret rather than a service-account key. In step 1.5 use the KEYS tab of\n" +
          "     the service account itself, not Credentials → OAuth client.",
      );
    } else if (!key.client_email || !key.private_key) {
      fail("Key file contents", "Missing client_email or private_key — the file looks truncated.");
    } else {
      clientEmail = key.client_email;
      pass("Key file", `service_account in project ${key.project_id ?? "(unknown)"}`);
      pass("Service account", clientEmail);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      "Key file",
      msg.includes("ENOENT")
        ? `Not found at that path. Check for typos, and that the file wasn't moved out of\n     Downloads. Path given: ${env.GA4_CREDENTIALS_PATH}`
        : `Could not read or parse: ${msg}`,
    );
  }

  if (results.some((r) => !r.ok)) {
    report();
    process.exit(1);
  }

  // ---- 3. Does the API actually answer? ----------------------------------
  //
  // Deliberately a tiny query — one metric, one day. The point is to find out whether the
  // credentials, the API and the property permission all line up, not to fetch data.
  try {
    const { BetaAnalyticsDataClient } = await import("@google-analytics/data");
    const client = new BetaAnalyticsDataClient({
      keyFilename: env.GA4_CREDENTIALS_PATH,
    });

    const [res] = await client.runReport({
      property: `properties/${env.GA4_PROPERTY_ID}`,
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      metrics: [{ name: "sessions" }],
    });

    const sessions = res.rows?.[0]?.metricValues?.[0]?.value ?? "0";
    pass("API call", `succeeded — ${Number(sessions).toLocaleString("en-US")} sessions in the last 7 days`);

    if (Number(sessions) === 0) {
      console.log(
        "\n  Note: the call worked but returned zero sessions. That usually means the\n" +
          "  Property ID points at a property with no traffic — e.g. a test property, or the\n" +
          "  wrong site if the account has several. Worth confirming it's the Esses one.\n",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Google returns the same 403 for several distinct mistakes. Name them all rather than
    // passing its message through, because on its own it does not say which applies.
    if (/PERMISSION_DENIED|403|caller does not have permission/i.test(msg)) {
      fail(
        "API call",
        "Permission denied. One of these, in likelihood order:\n" +
          `     1. ${clientEmail || "the service account"}\n` +
          "        was added to ACCOUNT access management instead of PROPERTY access\n" +
          "        management. They're different screens, in different columns of the same\n" +
          "        Admin page. Redo step 2.1 and check you're in the Property column.\n" +
          "     2. It was added to a different GA4 property than the one in GA4_PROPERTY_ID.\n" +
          "     3. The Google Analytics DATA API isn't enabled in the same Cloud project the\n" +
          "        key came from — step 1.2. Note the project dropdown must match.",
      );
    } else if (/has not been used in project|SERVICE_DISABLED|API .* disabled/i.test(msg)) {
      fail(
        "API call",
        "The Google Analytics Data API is not enabled in that Cloud project.\n" +
          "     Step 1.2 — and make sure the project dropdown reads esses-analytics, since\n" +
          "     enabling it in a different project is the usual cause.\n" +
          "     Careful: 'Google Analytics API' (retired) and 'Google Analytics Admin API'\n" +
          "     are both wrong. It must be 'Google Analytics Data API'.",
      );
    } else if (/INVALID_ARGUMENT|property/i.test(msg) && /not found|invalid/i.test(msg)) {
      fail(
        "API call",
        `Property ${env.GA4_PROPERTY_ID} was rejected. If that number came from anywhere other\n` +
          "     than Admin → Property details → PROPERTY ID, it's probably the wrong field.\n" +
          "     The Measurement ID (G-...) will not work here. Step 2.2.",
      );
    } else {
      fail("API call", msg.split("\n")[0]);
    }
  }

  report();
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.log(`${failed} check(s) failed. Walkthrough: docs/ga4-setup.md\n`);
    process.exit(1);
  }
  console.log("GA4 is connected.\n");
}

function report() {
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"}  ${r.label}${r.detail ? `  ${r.ok ? r.detail : ""}` : ""}`);
    if (!r.ok) console.log(`     ${r.detail}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

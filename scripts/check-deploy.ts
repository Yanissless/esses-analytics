/**
 * Preflight check for a deployment.
 *
 *   run.cmd check:deploy                     # check everything, including live API calls
 *   run.cmd check:deploy --skip-connectors   # config and database only, no network
 *
 * Point it at whichever database you want to inspect:
 *   $env:DATABASE_URL = "<production string>"; .\run.cmd check:deploy
 *
 * Written to be run by someone who doesn't know the codebase: every failure says what
 * to DO about it, not just what's wrong. Exits non-zero if anything critical fails, so
 * it also works as a smoke test in a script.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

/*
 * ⚠️ Everything touching `src/lib/env` is imported LAZILY, inside the function that
 * needs it.
 *
 * `env.ts` validates with zod at module load and throws on the first bad variable, and
 * `src/db/client` imports it. A static import therefore killed this script before it
 * printed anything — so the one situation a deployment check exists for, a misconfigured
 * deployment, was the one situation it could not diagnose.
 *
 * The secret checks read `process.env` directly and always run, whatever state the
 * configuration is in.
 */
type Db = (typeof import("../src/db/client"))["db"];

let cachedDb: Db | null = null;

/** Load the DB client, turning an env-validation crash into a reportable finding. */
async function loadDb(): Promise<{ db: Db } | { error: string }> {
  if (cachedDb) return { db: cachedDb };
  try {
    const mod = await import("../src/db/client");
    cachedDb = mod.db;
    return { db: mod.db };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type Level = "ok" | "warn" | "fail";

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What to do about it, in plain language. Omitted when there's nothing to do. */
  fix?: string;
}

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

const ICON: Record<Level, string> = { ok: "PASS", warn: "WARN", fail: "FAIL" };

async function scalar<T>(q: ReturnType<typeof sql>): Promise<T | null> {
  if (!cachedDb) return null;
  const rows = (await cachedDb.execute(q)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return Object.values(row)[0] as T;
}

async function checkSecrets() {
  const authSecret = process.env.AUTH_SECRET ?? "";
  if (!authSecret) {
    add({
      name: "AUTH_SECRET",
      level: "fail",
      detail: "not set — nobody can sign in",
      fix: "Generate one with: openssl rand -base64 48, then set it in the environment.",
    });
  } else if (authSecret.length < 32) {
    add({
      name: "AUTH_SECRET",
      level: "fail",
      detail: `only ${authSecret.length} characters`,
      fix: "Must be at least 32. Regenerate with: openssl rand -base64 48",
    });
  } else {
    add({ name: "AUTH_SECRET", level: "ok", detail: `set (${authSecret.length} chars)` });
  }

  const cron = process.env.CRON_SECRET ?? "";
  if (!cron) {
    add({
      name: "CRON_SECRET",
      level: "warn",
      detail: "not set — the nightly refresh is disabled and /api/sync refuses everything",
      fix: "Fine locally. On a deployed instance, generate one (openssl rand -base64 48) and add it in Vercel, then redeploy.",
    });
  } else if (cron.length < 32) {
    add({
      name: "CRON_SECRET",
      level: "fail",
      detail: `only ${cron.length} characters — the app requires at least 32`,
      fix: "Regenerate with: openssl rand -base64 48",
    });
  } else {
    add({ name: "CRON_SECRET", level: "ok", detail: "set — nightly refresh can run" });
  }
}

async function checkDatabase(): Promise<boolean> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    add({
      name: "DATABASE_URL",
      level: "fail",
      detail: "not set",
      fix: "Set it to your database connection string before running anything else.",
    });
    return false;
  }

  // Report which database WITHOUT printing credentials — the commonest doctor mistake
  // is running it against the wrong one, so the host matters; the password never does.
  let host = "unparseable";
  let pooled = false;
  try {
    const u = new URL(url);
    host = u.host;
    pooled = /-pooler\./.test(u.host) || u.searchParams.has("pgbouncer");
  } catch {
    /* keep the placeholder */
  }

  const loaded = await loadDb();
  if ("error" in loaded) {
    add({
      name: "Configuration",
      level: "fail",
      detail: loaded.error.split("\n")[0],
      fix: "Fix the variables named above, then run this again. See .env.example for the full list.",
    });
    return false;
  }

  try {
    await loaded.db.execute(sql`SELECT 1`);
  } catch (err) {
    add({
      name: "Database connection",
      level: "fail",
      detail: `cannot reach ${host}: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Check the connection string is complete and the database is running.",
    });
    return false;
  }

  add({ name: "Database connection", level: "ok", detail: `connected to ${host}` });

  const isLocal = /localhost|127\.0\.0\.1/.test(host);
  if (!isLocal && !pooled) {
    add({
      name: "Connection pooling",
      level: "warn",
      detail: "this looks like a remote database but not a pooled connection string",
      fix: "On Neon/Supabase, switch on connection pooling and use the string containing '-pooler'. Without it the site works at first, then fails once a few people use it.",
    });
  }

  return true;
}

async function checkSchema(): Promise<boolean> {
  const tables = await scalar<number>(sql`
    SELECT count(*)::int FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('users','orders','order_profit','daily_metrics','goals')
  `);
  if ((tables ?? 0) < 5) {
    add({
      name: "Schema",
      level: "fail",
      detail: `only ${tables ?? 0} of 5 core tables exist`,
      fix: "Run: .\\run.cmd db:migrate",
    });
    return false;
  }
  add({ name: "Schema", level: "ok", detail: "all core tables present" });
  return true;
}

async function checkAdmins() {
  const admins = await scalar<number>(sql`
    SELECT count(*)::int FROM users WHERE role = 'admin' AND is_active = true
  `);
  if (!admins) {
    add({
      name: "Admin account",
      level: "fail",
      detail: "no active admin exists — nobody can manage the app",
      fix: 'Run: $env:SEED_ADMIN_PASSWORD = "a-long-password"; .\\run.cmd db:seed',
    });
    return;
  }
  const total = await scalar<number>(sql`SELECT count(*)::int FROM users WHERE is_active = true`);
  add({
    name: "Admin account",
    level: "ok",
    detail: `${admins} active admin(s), ${total} active user(s) total`,
  });
}

async function checkData() {
  const orders = await scalar<number>(sql`
    SELECT count(*)::int FROM orders
     WHERE test = false AND cancelled_at IS NULL AND counts_as_revenue = true
  `);

  if (!orders) {
    add({
      name: "Data loaded",
      level: "fail",
      detail: "no countable orders — every dashboard will show zero",
      fix: "Run the backfill against THIS database: .\\run.cmd backfill --since=2025-10-01 --source=shopify (then skio, stripe), followed by .\\run.cmd metrics",
    });
    return;
  }

  const lastOrder = await scalar<string>(sql`SELECT max(processed_at)::date::text FROM orders`);
  add({
    name: "Data loaded",
    level: "ok",
    detail: `${orders.toLocaleString()} countable orders, latest ${lastOrder ?? "unknown"}`,
  });

  /*
   * The trap this project keeps hitting: order_profit and daily_metrics are
   * materialised, so a backfill without a following `metrics` run leaves the margin
   * and International pages silently under-reporting. Comparing row counts catches it.
   */
  const profitRows = await scalar<number>(sql`SELECT count(*)::int FROM order_profit`);
  if (profitRows !== orders) {
    add({
      name: "Metrics freshness",
      level: "warn",
      detail: `order_profit holds ${(profitRows ?? 0).toLocaleString()} rows against ${orders.toLocaleString()} countable orders`,
      fix: "Run: .\\run.cmd metrics — until you do, the Profit and International pages under-report.",
    });
  } else {
    const lastMetric = await scalar<string>(sql`
      SELECT max(date)::text FROM daily_metrics WHERE channel IS NULL
    `);
    add({
      name: "Metrics freshness",
      level: "ok",
      detail: `rebuilt for all ${orders.toLocaleString()} orders, daily metrics to ${lastMetric ?? "unknown"}`,
    });
  }
}

async function checkConnectors() {
  // Lazy for the same reason as the DB client — these all pull in the env schema.
  let connectorConfigured: typeof import("../src/lib/env")["connectorConfigured"];
  let shopifyConnector: typeof import("../src/connectors/shopify")["shopifyConnector"];
  let skioConnector: typeof import("../src/connectors/skio")["skioConnector"];
  let stripeConnector: typeof import("../src/connectors/stripe")["stripeConnector"];
  let AD_PLATFORMS: typeof import("../src/connectors/ads")["AD_PLATFORMS"];
  let asConnector: typeof import("../src/connectors/ads")["asConnector"];
  try {
    ({ connectorConfigured } = await import("../src/lib/env"));
    ({ shopifyConnector } = await import("../src/connectors/shopify"));
    ({ skioConnector } = await import("../src/connectors/skio"));
    ({ stripeConnector } = await import("../src/connectors/stripe"));
    ({ AD_PLATFORMS, asConnector } = await import("../src/connectors/ads"));
  } catch (err) {
    add({
      name: "Connectors",
      level: "warn",
      detail: `could not be checked: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      fix: "Fix the configuration errors above first, then run this again.",
    });
    return;
  }

  const targets: Array<{ label: string; configured: boolean; check: () => Promise<{ ok: boolean; detail?: string }> }> = [
    { label: "Shopify", configured: connectorConfigured.shopify(), check: () => shopifyConnector.healthCheck() },
    { label: "Skio", configured: connectorConfigured.skio(), check: () => skioConnector.healthCheck() },
    { label: "Stripe", configured: connectorConfigured.stripe(), check: () => stripeConnector.healthCheck() },
    ...AD_PLATFORMS.map((p) => ({
      label: p.label,
      configured: p.isConfigured(),
      check: () => asConnector(p).healthCheck(),
    })),
  ];

  for (const t of targets) {
    if (!t.configured) {
      add({
        name: t.label,
        level: "warn",
        detail: "not configured — that source simply won't sync",
        fix: `Add the ${t.label} credentials to the environment if you want this data.`,
      });
      continue;
    }
    try {
      const r = await t.check();
      if (r.ok) {
        add({ name: t.label, level: "ok", detail: "credentials work" });
      } else {
        add({
          name: t.label,
          level: "warn",
          detail: r.detail ?? "health check failed",
          fix:
            t.label.toLowerCase().includes("meta")
              ? "Known: Meta has blocked the app itself, not the token — a new token won't help. See HANDOFF.md section 5.2."
              : "Check the credentials for this source.",
        });
      }
    } catch (err) {
      add({
        name: t.label,
        level: "warn",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function main() {
  const skipConnectors = process.argv.includes("--skip-connectors");

  console.log("\nEsses Analytics — deployment check\n");

  await checkSecrets();
  const connected = await checkDatabase();
  if (connected) {
    const schemaOk = await checkSchema();
    if (schemaOk) {
      await checkAdmins();
      await checkData();
    }
  }
  if (!skipConnectors) {
    console.log("Checking connectors (this makes one API call each)…\n");
    await checkConnectors();
  }

  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  for (const c of checks) {
    console.log(`  ${ICON[c.level]}  ${c.name.padEnd(width)}${c.detail}`);
    if (c.fix && c.level !== "ok") console.log(`        ↳ ${c.fix}`);
  }

  const fails = checks.filter((c) => c.level === "fail");
  const warns = checks.filter((c) => c.level === "warn");

  console.log("");
  if (fails.length) {
    console.log(
      `${fails.length} thing(s) must be fixed before this instance will work properly.`,
    );
  } else if (warns.length) {
    console.log(`Ready to use. ${warns.length} thing(s) worth a look, none blocking.`);
  } else {
    console.log("Everything checks out.");
  }
  console.log("");

  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error("Doctor failed to run:", err instanceof Error ? err.message : err);
  process.exit(1);
});

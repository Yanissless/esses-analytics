/**
 * Scheduled incremental sync.
 *
 * Exists so a deployed instance keeps its data fresh without anyone running the CLI.
 * Runs the same `runSync()` the `sync` script does.
 *
 * ⚠️ **Incremental only — never use this for a backfill.** A full backfill walks ~170
 * sequential Shopify pages and takes about ten minutes, which exceeds serverless
 * function limits on every plan. Backfills stay a deliberate operator action, run from a
 * machine against the production database:
 *
 *   DATABASE_URL=<prod> run.cmd backfill --since=2025-10-01 --source=shopify
 *
 * Auth is a shared secret rather than a session, because a scheduler has no user. It
 * fails CLOSED: with `CRON_SECRET` unset every request is refused, so a deployment that
 * forgets to set it cannot leave an unauthenticated endpoint that spends money on
 * third-party APIs.
 */
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ALL_SYNC_SOURCES, runSync } from "@/lib/sync/run-sync";

/** The sync is long-running and DB-bound; it must not run on the Edge runtime. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * The platform ceiling, requested in full.
 *
 * The old comment here claimed "incremental is ~10s in practice". Measured on 18 Aug 2026 it
 * was NINE MINUTES, dominated by a Skio connector that re-read all 3,935 subscriptions every
 * run. Per source, skipping the rollup:
 *
 *   shopify    36.6s
 *   skio      479.2s   <- fixed; now filters on updatedAt
 *   stripe      6.0s
 *   ads        10.5s
 *   instagram   4.4s
 *   metrics     4.3s
 *
 * 300s is the maximum Vercel allows and it needs a PRO plan; Hobby caps lower. If a run ever
 * approaches it again, split the schedule per source in vercel.json rather than raising this,
 * because there is nothing above 300 to raise it to.
 *
 * Why an overrun is worse than it sounds: the platform kills the function from outside, so
 * `withSyncRun` never runs its failure branch. The run stays marked started-but-never-finished
 * and the freshness banner reports data as current. A silent nightly half-sync.
 */
export const maxDuration = 300;

/** Constant-time compare so a wrong secret can't be recovered by timing the response. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(req: NextRequest): { ok: true } | { ok: false; status: number; msg: string } {
  const expected = env.CRON_SECRET;
  if (!expected) {
    // Fail closed, and say why — this is an operator error, not an attack.
    return {
      ok: false,
      status: 503,
      msg: "CRON_SECRET is not configured, so scheduled sync is disabled.",
    };
  }

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; allow a plain header too
  // so other schedulers work without contortions.
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const alt = req.headers.get("x-cron-secret") ?? "";
  const provided = bearer || alt;

  if (!provided || !secretMatches(provided, expected)) {
    return { ok: false, status: 401, msg: "Unauthorized." };
  }
  return { ok: true };
}

export async function POST(req: NextRequest) {
  const auth = authorize(req);
  if (!auth.ok) {
    logger.warn("Rejected /api/sync request", { status: auth.status });
    return NextResponse.json({ error: auth.msg }, { status: auth.status });
  }

  // ?full=skio forces a complete reload of that source instead of reading from its cursor.
  // Meant for a weekly reconcile cron; see the note on `full` in run-sync.ts.
  const fullParam = req.nextUrl.searchParams.get("full");
  const full = fullParam
    ? fullParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const requested = req.nextUrl.searchParams.get("source");
  const sources = requested
    ? requested.split(",").map((s) => s.trim()).filter(Boolean)
    : [...ALL_SYNC_SOURCES];

  const unknown = sources.filter((s) => !(ALL_SYNC_SOURCES as readonly string[]).includes(s));
  if (unknown.length) {
    return NextResponse.json(
      { error: `Unknown source(s): ${unknown.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const summary = await runSync({ sources, full });
    // 207 when some sources failed: the scheduler should notice, but the run did
    // useful work and retrying everything would be wrong.
    return NextResponse.json(summary, { status: summary.ok ? 200 : 207 });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("Scheduled sync threw", { error });
    return NextResponse.json({ error }, { status: 500 });
  }
}

/**
 * Vercel Cron issues GET, so accept it as an alias. Kept explicit rather than sharing a
 * handler name so it's obvious this endpoint mutates data despite being reachable by GET.
 */
export const GET = POST;

/**
 * Scheduled daily digest email — CPR, churn, new subscribers, and ad spend
 * breakdown for the previous calendar day, sent to the team.
 *
 * Same shared-secret auth as `/api/sync` (see that route's header comment for
 * the full reasoning) — a scheduler has no user session, and the endpoint
 * fails CLOSED without `CRON_SECRET` set rather than running unauthenticated.
 *
 * Runs AFTER the sync cron (`vercel.json` schedules this 15 minutes later),
 * so the digest reflects data that actually finished syncing rather than
 * whatever was on hand when the two crons happened to race.
 */
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getDailyDigest, yesterday } from "@/metrics/daily-digest";
import { digestHtml, digestSubject, digestText } from "@/lib/email/daily-digest-template";
import { sendEmail } from "@/lib/email/mailgun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(req: NextRequest): { ok: true } | { ok: false; status: number; msg: string } {
  const expected = env.CRON_SECRET;
  if (!expected) {
    return { ok: false, status: 503, msg: "CRON_SECRET is not configured, so the scheduled digest is disabled." };
  }
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const provided = bearer || req.headers.get("x-cron-secret") || "";
  if (!provided || !secretMatches(provided, expected)) {
    return { ok: false, status: 401, msg: "Unauthorized." };
  }
  return { ok: true };
}

export async function POST(req: NextRequest) {
  const auth = authorize(req);
  if (!auth.ok) {
    logger.warn("Rejected /api/cron/daily-digest request", { status: auth.status });
    return NextResponse.json({ error: auth.msg }, { status: auth.status });
  }

  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) {
    const msg = "MAILGUN_API_KEY / MAILGUN_DOMAIN not set — digest computed but not sent.";
    logger.warn(msg);
    return NextResponse.json({ error: msg }, { status: 503 });
  }
  const recipients = (env.DIGEST_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) {
    const msg = "DIGEST_RECIPIENTS is empty — digest computed but not sent.";
    logger.warn(msg);
    return NextResponse.json({ error: msg }, { status: 503 });
  }

  // ?date=YYYY-MM-DD overrides for a manual resend of a specific day; defaults to yesterday.
  const dateParam = req.nextUrl.searchParams.get("date");
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : yesterday();

  try {
    const digest = await getDailyDigest(date);
    await sendEmail({
      to: recipients,
      subject: digestSubject(digest),
      html: digestHtml(digest, env.APP_BASE_URL),
      text: digestText(digest, env.APP_BASE_URL),
    });
    logger.info("Daily digest sent", { date, recipients: recipients.length });
    return NextResponse.json({ ok: true, date, recipients });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("Daily digest failed", { date, error });
    return NextResponse.json({ error }, { status: 500 });
  }
}

/** Vercel Cron issues GET. */
export const GET = POST;

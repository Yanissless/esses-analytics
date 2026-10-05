/**
 * Test or manually trigger the daily digest email from the command line.
 *
 *   pnpm digest:preview                 # print the digest + write a local HTML preview
 *   pnpm digest:send                    # actually email it
 *   pnpm digest:send -- --date=2026-09-21   # a specific day, e.g. to resend one
 *
 * Defaults to a dry run on purpose — this exists so Sam can check the numbers
 * are right, and now see exactly what the email will LOOK like (not just the
 * plaintext dump), BEFORE the first real send goes to Ojus, Johnny and Hugh's
 * inboxes. The scheduled cron always sends for real; only this manual entry
 * point defaults to safe.
 *
 * This is the interim tool while the digest is still being tested and
 * refined — no Mailgun credentials needed at all to use `digest:preview`.
 * Wire up the cron in vercel.json only once the content itself is settled.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../src/lib/env";
import { getDailyDigest, yesterday } from "../src/metrics/daily-digest";
import { digestHtml, digestSubject, digestText } from "../src/lib/email/daily-digest-template";
import { sendEmail } from "../src/lib/email/mailgun";

const PREVIEW_PATH = resolve(__dirname, "..", "digest-preview.html");

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const dateArg = args.find((a) => a.startsWith("--date="))?.split("=")[1];
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : yesterday();

  console.log(`\nDaily digest — ${date}${send ? " (SENDING)" : " (dry run — pass --send to actually email)"}\n`);

  const recipients = (env.DIGEST_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  console.log("Recipients:", recipients.length ? recipients.join(", ") : "(none — set DIGEST_RECIPIENTS in .env)");
  console.log(
    "Mailgun:",
    env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN
      ? `configured (${env.MAILGUN_DOMAIN})`
      : "not configured yet — fine for a preview, needed for --send",
  );
  console.log();

  const digest = await getDailyDigest(date);
  console.log("Subject:", digestSubject(digest));
  console.log();
  console.log(digestText(digest, env.APP_BASE_URL));
  console.log();

  // Written every run, send or dry-run alike, so there's always an up-to-date visual copy to
  // open in a browser — the plaintext above tells you the numbers are right, this tells you
  // it's not going to look broken in someone's inbox.
  writeFileSync(PREVIEW_PATH, digestHtml(digest, env.APP_BASE_URL), "utf8");
  console.log(`Visual preview written to: ${PREVIEW_PATH}`);
  console.log("(open it in a browser to see exactly what the email will look like)");
  console.log();

  if (!send) {
    console.log("Dry run only — nothing sent. Re-run with --send to actually email it.");
    process.exit(0);
  }

  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) {
    console.error("Cannot send: Mailgun is not configured. See TEAM-SETUP.md / .env.example.");
    process.exit(1);
  }
  if (recipients.length === 0) {
    console.error("Cannot send: DIGEST_RECIPIENTS is empty.");
    process.exit(1);
  }

  await sendEmail({
    to: recipients,
    subject: digestSubject(digest),
    html: digestHtml(digest, env.APP_BASE_URL),
    text: digestText(digest, env.APP_BASE_URL),
  });
  console.log(`Sent to ${recipients.length} recipient(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Digest failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

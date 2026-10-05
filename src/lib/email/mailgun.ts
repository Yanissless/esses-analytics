/**
 * Thin Mailgun client — one function, no SDK dependency.
 *
 * Mailgun's send API is a single `multipart/form-data` POST with HTTP Basic
 * auth (username `api`, password = the API key). That's small enough not to
 * need `mailgun.js` as a dependency for what is currently one call site.
 *
 * ## US vs EU
 *
 * A Mailgun account created under the EU region must send through
 * `api.eu.mailgun.net`, not `api.mailgun.net` — using the wrong one fails
 * with an opaque 401, not a helpful error. `MAILGUN_API_BASE` covers it;
 * unset it and this defaults to US, which is what most new accounts are.
 */
import { env } from "../env";

export interface SendEmailInput {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export class MailgunNotConfiguredError extends Error {
  constructor() {
    super("MAILGUN_API_KEY and MAILGUN_DOMAIN must both be set to send email.");
    this.name = "MailgunNotConfiguredError";
  }
}

/** Sends one email to every address in `to` as a single message (all recipients
 *  see each other, same as a normal CC) — right for a 4-person internal digest,
 *  wrong for anything sent to customers. */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const { MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_API_BASE } = env;
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) throw new MailgunNotConfiguredError();

  const base = MAILGUN_API_BASE || "https://api.mailgun.net";
  const from = MAILGUN_FROM || `Esses Analytics <reports@${MAILGUN_DOMAIN}>`;

  const form = new URLSearchParams();
  form.set("from", from);
  for (const addr of input.to) form.append("to", addr);
  form.set("subject", input.subject);
  form.set("html", input.html);
  form.set("text", input.text);

  const res = await fetch(`${base}/v3/${MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${MAILGUN_API_KEY}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mailgun send failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`);
  }
}

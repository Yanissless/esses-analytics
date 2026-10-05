/**
 * Renders the daily digest as HTML + plaintext. Kept deliberately plain —
 * table-based HTML, inline styles, no external assets — because this goes
 * through an email client, not a browser, and anything fancier risks Outlook
 * or Gmail mangling it. No dependency on `_components/ui.tsx`, which targets
 * Tailwind-in-a-browser and would not render at all in an inbox.
 */
import type { DailyDigest } from "../../metrics/daily-digest";

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cpr = (cents: number | null) => (cents == null ? "—" : usd(cents));
const num = (n: number) => n.toLocaleString("en-US");

/** "45s", "12m", "3h 20m" — matches how fast these actually happen, which is
 *  the whole point of surfacing them (see daily-digest.ts's module docstring). */
function formatDuration(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function digestSubject(d: DailyDigest): string {
  const net = d.newSubscribers.total - d.churn.total;
  const sign = net > 0 ? "+" : "";
  const flag =
    d.rapidCancelSummary.total > 0 ? `⚠ ${d.rapidCancelSummary.total} same-day cancel — ` : "";
  return `${flag}Esses Analytics — ${d.date} — ${usd(d.adSpend.totalCents)} spend, ${sign}${net} net subs`;
}

// abandoned_checkout is red, not amber, on purpose: confirmed 23 Sep 2026 this is a
// checkout-flow bug (a separate API call voids the invoice and expires the subscription
// within seconds to minutes, never a real payment attempt) — not customer behaviour, and
// not something to soft-pedal next to "kept access" and "lost", which both ARE customer
// choices. See daily-digest.ts's module docstring and the "no abandoned Stripe checkouts"
// check in lib/validate/checks.ts.
const OUTCOME_LABEL: Record<string, string> = {
  abandoned_checkout: "ERROR — abandoned checkout",
  kept_access: "Kept access",
  cancelled: "Lost",
};
const OUTCOME_COLOR: Record<string, string> = {
  abandoned_checkout: "#a71a1a",
  kept_access: "#1a7a1a",
  cancelled: "#a71a1a",
};

/**
 * Detail table for today's rapid cancellations — the `outcome` column is the
 * point (see daily-digest.ts's module docstring for what each value means
 * and why "cancelled" was the wrong word for most of these). No narrative
 * text here on purpose — the summary line lives in the overview tiles now.
 */
function digestRapidCancelTable(d: DailyDigest): string {
  if (d.rapidCancellations.length === 0) return "";

  const rows = d.rapidCancellations
    .map((r) => {
      const who = escapeHtml(r.customerName ?? r.customerEmail);
      const promo = r.promoCode != null ? escapeHtml(r.promoCode) : "none";
      const paid = r.paidCents != null ? usd(r.paidCents) : "—";
      return `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${who}<br/><span style="color:#999;font-size:11px;">${escapeHtml(r.customerEmail)}</span></td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-transform:capitalize;">${escapeHtml(r.source)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(r.planName ?? "—")}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${promo}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${paid}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${OUTCOME_COLOR[r.outcome]};font-weight:600;">${OUTCOME_LABEL[r.outcome]}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${formatDuration(r.minutesToCancel)}</td>
    </tr>`;
    })
    .join("");

  return `
  <h2 style="font-size:14px;margin:0 0 8px;">Same-day cancellations</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
    <thead>
      <tr style="text-align:left;color:#666;text-transform:uppercase;font-size:11px;">
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Who</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Via</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Plan</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Promo</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">Paid</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Outcome</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">Time</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Forward-looking companion to the rapid-cancel table above — added 30 Sep
 * 2026, prompted by Craft reporting 64 cancellations in a day this digest's
 * own churn count didn't fully explain. `stripeWillEnd` is not a guess: Stripe
 * already has `cancel_at_period_end = true` recorded today, so every one of
 * these has already decided not to renew — this just surfaces it before the
 * day it lands instead of after.
 */
function digestForecastSection(d: DailyDigest): string {
  const f = d.expiringForecast;
  const dayRows = f.byDay
    .map(
      (day) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${day.date}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${num(day.stripeWillRenew)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;${day.stripeWillEnd > 0 ? "color:#a71a1a;font-weight:600;" : ""}">${num(day.stripeWillEnd)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${day.stripeMrrAtRiskCents > 0 ? usd(day.stripeMrrAtRiskCents) : "—"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${num(day.skioRenewalsDue)}</td>
    </tr>`,
    )
    .join("");

  return `
  <h2 style="font-size:14px;margin:24px 0 8px;">Expiring subscriptions — next ${f.windowDays} days</h2>
  <p style="font-size:12px;color:#666;margin:0 0 8px;">
    "Will end" is already decided (Stripe auto-renew is off) — not a prediction, a known upcoming loss.
    Skio renewals can't be split this way (see below) and are shown as "due" only.
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;">
    <thead>
      <tr style="text-align:left;color:#666;text-transform:uppercase;font-size:11px;">
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Date</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">Stripe will renew</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">Stripe will end</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">MRR at risk</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">Skio due</th>
      </tr>
    </thead>
    <tbody>${dayRows}</tbody>
  </table>
  <p style="font-size:12px;color:#666;margin:0 0 20px;">
    Total over the window: <strong style="color:${f.totalStripeWillEnd > 0 ? "#a71a1a" : "#111"};">${num(f.totalStripeWillEnd)} Stripe subscriptions will end</strong>
    (${usd(f.totalStripeMrrAtRiskCents)} MRR), plus ${num(f.totalSkioRenewalsDue)} Skio renewals due
    (Skio's schema has no auto-renew-off flag, so these can't be split into will-renew vs will-end in advance).
  </p>`;
}

export function digestHtml(d: DailyDigest, appBaseUrl: string): string {
  const campaignRows = d.adSpend.byCampaign
    .map(
      (c) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;">${escapeHtml(c.campaignName)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;text-transform:capitalize;">${escapeHtml(c.platform)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:right;">${usd(c.spendCents)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:right;">${num(c.results)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:right;">${cpr(c.cprCents)}</td>
    </tr>`,
    )
    .join("");

  const noSpend = d.adSpend.byCampaign.length === 0
    ? `<tr><td colspan="5" style="padding:10px;color:#666;">No ad spend recorded for this day.</td></tr>`
    : "";

  return `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111;">
  <h1 style="font-size:18px;margin:0 0 4px;">Esses Analytics — Daily Digest</h1>
  <p style="font-size:13px;color:#666;margin:0 0 20px;">Reporting ${d.date} · sent from data synced this morning</p>

  <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
    <tr>
      <td style="width:25%;padding:12px;background:#f7f7f7;border-radius:6px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;">Ad spend</div>
        <div style="font-size:20px;font-weight:600;">${usd(d.adSpend.totalCents)}</div>
      </td>
      <td style="width:5%;"></td>
      <td style="width:25%;padding:12px;background:#f7f7f7;border-radius:6px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;">Blended CPR</div>
        <div style="font-size:20px;font-weight:600;">${cpr(d.adSpend.blendedCprCents)}</div>
      </td>
      <td style="width:5%;"></td>
      <td style="width:20%;padding:12px;background:#f0faf0;border-radius:6px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;">New subs</div>
        <div style="font-size:20px;font-weight:600;color:#1a7a1a;">+${num(d.newSubscribers.total)}</div>
      </td>
      <td style="width:5%;"></td>
      <td style="width:20%;padding:12px;background:#faf0f0;border-radius:6px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;">Churn</div>
        <div style="font-size:20px;font-weight:600;color:#a71a1a;">-${num(d.churn.total)}</div>
      </td>
    </tr>
  </table>

  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <tr>
      <td style="padding:12px;background:${d.rapidCancelSummary.abandonedCheckout > 0 ? "#fdf3f3" : "#fbf8f0"};border-radius:6px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;">Same-day cancels (of today's new signups)</div>
        <div style="font-size:20px;font-weight:600;color:${d.rapidCancelSummary.abandonedCheckout > 0 ? "#a71a1a" : "#8a6d1a"};">${num(d.rapidCancelSummary.total)}</div>
        <div style="font-size:12px;color:#666;margin-top:4px;">
          ${d.rapidCancelSummary.total === 0
            ? "none today ✓"
            : `${d.rapidCancelSummary.abandonedCheckout > 0 ? `<strong style="color:#a71a1a;">${num(d.rapidCancelSummary.abandonedCheckout)} abandoned checkout — checkout-flow bug, see below</strong> · ` : ""}${num(d.rapidCancelSummary.keptAccess)} kept access (paid, just turned off auto-renew) ·
               ${num(d.rapidCancelSummary.cancelled)} actually lost`}
        </div>
      </td>
    </tr>
  </table>

  <p style="font-size:13px;color:#444;margin:0 0 20px;">
    ${num(d.activeSubscribers)} active subscribers as of today (Skio + Stripe)${d.pendingCancellation > 0 ? ` — includes ${num(d.pendingCancellation)} set to cancel (auto-renew off, access not lost yet)` : ""}.
    Net change yesterday: <strong>${d.newSubscribers.total - d.churn.total >= 0 ? "+" : ""}${d.newSubscribers.total - d.churn.total}</strong>
    (${num(d.newSubscribers.skio)} Skio / ${num(d.newSubscribers.stripe)} Stripe new,
     ${num(d.churn.skio)} Skio / ${num(d.churn.stripe)} Stripe churned).
  </p>

  ${digestRapidCancelTable(d)}

  ${digestForecastSection(d)}

  <h2 style="font-size:14px;margin:0 0 8px;">Ad spend breakdown</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;">
    <thead>
      <tr style="text-align:left;color:#666;text-transform:uppercase;font-size:11px;">
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Campaign</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;">Platform</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">Spend</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">Results</th>
        <th style="padding:6px 10px;border-bottom:2px solid #ccc;text-align:right;">CPR</th>
      </tr>
    </thead>
    <tbody>${campaignRows}${noSpend}</tbody>
  </table>

  <p style="font-size:12px;color:#999;margin:24px 0 0;">
    CPR is cost per platform-reported result — the same figure the ad platform itself shows,
    not a Shopify-derived conversion. "New subs" and "churn" count subscription status changes
    that happened ON this date (Skio + Stripe), not orders.
    <a href="${appBaseUrl}/marketing" style="color:#666;">Full detail on /marketing →</a>
  </p>
</div>`.trim();
}

export function digestText(d: DailyDigest, appBaseUrl: string): string {
  const lines: string[] = [];
  lines.push(`Esses Analytics — Daily Digest — ${d.date}`);
  lines.push("");
  lines.push(`Ad spend:        ${usd(d.adSpend.totalCents)}`);
  lines.push(`Blended CPR:     ${cpr(d.adSpend.blendedCprCents)}`);
  lines.push(`New subscribers: +${d.newSubscribers.total} (${d.newSubscribers.skio} Skio / ${d.newSubscribers.stripe} Stripe)`);
  lines.push(`Churn:           -${d.churn.total} (${d.churn.skio} Skio / ${d.churn.stripe} Stripe)`);
  lines.push(
    `Active subs now: ${d.activeSubscribers}` +
      (d.pendingCancellation > 0 ? ` (includes ${d.pendingCancellation} set to cancel, access not lost yet)` : ""),
  );
  lines.push("");
  const s = d.rapidCancelSummary;
  lines.push(
    `Same-day cancels: ${s.total}` +
      (s.total > 0
        ? ` (${s.abandonedCheckout} abandoned checkout / ${s.keptAccess} kept access / ${s.cancelled} actually lost)`
        : ""),
  );
  if (s.total > 0) {
    for (const r of d.rapidCancellations) {
      const promo = r.promoCode != null ? r.promoCode : "none";
      const paid = r.paidCents != null ? usd(r.paidCents) : "—";
      lines.push(
        `  ${r.customerName ?? r.customerEmail} <${r.customerEmail}> — ${r.source}, ${r.planName ?? "—"}, promo: ${promo}, paid: ${paid} — ${OUTCOME_LABEL[r.outcome]} after ${formatDuration(r.minutesToCancel)}`,
      );
    }
  }
  lines.push("");
  const f = d.expiringForecast;
  lines.push(`Expiring subscriptions — next ${f.windowDays} days:`);
  for (const day of f.byDay) {
    lines.push(
      `  ${day.date} — ${day.stripeWillRenew} Stripe will renew, ${day.stripeWillEnd} will end` +
        (day.stripeWillEnd > 0 ? ` (${usd(day.stripeMrrAtRiskCents)} MRR at risk)` : "") +
        `, ${day.skioRenewalsDue} Skio due`,
    );
  }
  lines.push(
    `  Total: ${f.totalStripeWillEnd} Stripe will end (${usd(f.totalStripeMrrAtRiskCents)} MRR), ${f.totalSkioRenewalsDue} Skio renewals due`,
  );
  lines.push("");
  lines.push("Ad spend breakdown:");
  if (d.adSpend.byCampaign.length === 0) {
    lines.push("  (no ad spend recorded for this day)");
  } else {
    for (const c of d.adSpend.byCampaign) {
      lines.push(`  ${c.campaignName} [${c.platform}] — ${usd(c.spendCents)} / ${c.results} results / CPR ${cpr(c.cprCents)}`);
    }
  }
  lines.push("");
  lines.push(`Full detail: ${appBaseUrl}/marketing`);
  return lines.join("\n");
}

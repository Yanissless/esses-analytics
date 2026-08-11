# START HERE — handoff to Johnny

**Written:** 6 August 2026
**Handing over from:** Sam's build sessions (8 of them)
**Your job:** take this live at `analytics.esses.com`, then keep building.

Everything below is current and verified. Nothing is half-finished.

| File | What it's for |
|---|---|
| **`DEPLOY.md`** | The go-live walkthrough. Step by step, no assumed knowledge. **Start here for the deploy.** |
| **`CLAUDE.md`** | Auto-loaded by Claude Code. Conventions and hard rules — the things that already caused bugs. |
| **`HANDOFF.md`** | The deep archive: 70KB across 8 sessions. Every failed approach and open problem, with section numbers. Read on demand, not front to back. |
| **`START-HERE.md`** | This file. |

---

## 1. The goal

Replace **StoreHero.ai** with something Esses owns and can extend — matching its core
capability, then going further on the one thing it can't do: **unify customer lifetime
value across every revenue source**.

Revenue arrives from three places and must never be double-counted:

- **Shopify** — the single source of truth for ALL order revenue, one-time *and* Skio
  subscription orders
- **Skio** — enrichment ONLY: plan, status, churn, MRR. Never a second source of revenue
- **Stripe** — a separate, additive stream (print + digital subscriptions)

Target capabilities: daily sales/profit dashboard, marketing performance, profit-first
metrics (MER / aMER / CAC / CM1–CM3), forecasting against goals, unified LTV and cohorts,
and AI insights to Slack. Internal only, behind auth, on a hidden `esses.com` subdomain.

The governing principle throughout: **a number you know you can't trust is worth more
than one you wrongly believe.** Almost every page states its own coverage, boundary or
caveat in-line. Please keep that up — it's the reason this is more useful than the tool
it replaces.

---

## 2. Current state of the code

**Phases 1–9 of 11 are built.** Every major dashboard from the brief exists.

- **218 tests pass** · typecheck silent · lint 0 errors · build clean across **17 routes**
- Running against live data: 8,130 countable orders, $152,204 net revenue, MER 5.16
- Git: **13 commits on `master`**, working tree clean, **no remote yet** (that's your Part 1).
  The history is worth reading — each message explains *why*, not just what.

### Pages

`/` Overview · `/profit` · `/marketing` · `/social` · `/customers` · `/churn` ·
`/personas` · `/forecast` · `/international` · `/costs` · `/shipping` · `/team` ·
`/account` · `/login` · `/api/health` · `/api/sync`

### Roles

Three, defined once in `lib/auth/capabilities.ts`:

- **admin** — everything, plus edits costs/goals/people
- **viewer** — every read, no writes
- **marketing** — channel, campaign and cohort performance only. **No** cost/margin, **no**
  individual customer records. Built for an agency or freelancer.

### Stack notes worth knowing

Self-owned auth: jose-signed session cookies + bcryptjs, `proxy.ts` gates every route
deny-by-default. `requireUser()` re-checks the account on every page render, so
deactivating someone is immediate rather than waiting out a 7-day cookie.

`order_profit` is the materialised single source of per-order costed margin — the Profit
page once timed out resolving costs per line item four times per load.

---

## 3. Files most likely to need touching next

| File | Why |
|---|---|
| `src/metrics/order-profit.ts` | The one home for cost logic and the `revenue_class` CASE. Any margin change starts here. |
| `src/metrics/margin-boundary.ts` / `.server.ts` | The live cost-boundary setting. Note the pure/server split — rule 6 in `CLAUDE.md`. |
| `src/lib/shipping/rate-rules.ts` | The single shipping rate-rule predicate. Five copies had drifted before this existed. |
| `src/lib/auth/capabilities.ts` | Who can see what. Edit this, not individual pages. |
| `src/connectors/ads/meta.ts` | First thing to revisit once Meta is unblocked. |
| `src/metrics/churn.ts` | Cohort churn. Read the header note on billing vs delivery cadence before changing anything. |
| `scripts/check-deploy.ts` | The preflight check. Its imports are deliberately lazy — see the comment. |

Nothing is left half-written.

---

## 4. Everything tried that failed

The full list is `HANDOFF.md` §6 — long, and worth skimming before you debug anything.
The ones most likely to waste your time:

### Blocked externally — don't retry

- **Meta API is blocked at the APP level, not the token.** Ours returns OAuthException
  code **200** ("API access blocked"); a malformed token returns **190**, and
  `/debug_token` fails too — that endpoint answers even for expired tokens. **A new token
  from the same app will fail identically.**
  **Confirmed 2026-08-11 — it's a Meta enforcement action, and there is nothing to
  rebuild.** Meta's own debugger reports the token **Valid: True** — System User, never
  expires, `ads_read` + `read_insights`, on app **Esses Analytics** (`28698775013059115`).
  Also ruled out: an API version sunset (identical error on **v20.0–v26.0**). The block
  landed between **30 Jul and 4 Aug 2026**. Remediation is Meta-UI only and order-dependent
  — §5.2. Run **`run.cmd check:meta`**; it separates token / app / scope causes and prints
  the ordered fix.
  ⚠️ **The tell that cost us a detour:** on `developers.facebook.com` the top-right button
  reads "My Apps" for a registered developer and **"Get Started"** if you've never
  registered — in which case every app URL silently redirects, including app creation.
  Business Suite permissions do **not** register you as a developer.
- **ShopifyQL `shipping_labels`** needs `read_reports` *and* Level 2 protected customer
  data access. Deliberately non-fatal — shipping falls back to rate-rule estimates.

### Bugs that passed every test

- **Ingest mapping a field the GraphQL query never requested.** Silent NULLs, no error
  anywhere. Hit twice in one query — order country and presentment currency. **When a
  column is unexpectedly all-NULL, check the query before suspecting permissions.** Two
  sessions blamed Shopify's permissions; the field simply wasn't being asked for.
- **`revenue_class` duplicated into four copies**, two missing a branch. See rule 1.
- **Summing Meta's overlapping purchase action types** — inflated conversions ~3×. Caught
  by one sanity check: a platform can't drive more purchases than the store received.
- **AOV over all orders** — twice. 65% of orders are $0.
- **Trusting a stale `order_profit`** — I mis-diagnosed this once as a `processed_at`
  filter issue; it was simply that `metrics` hadn't been re-run. §4.11 has the correction.

### Tooling gotchas

- PowerShell has no inline env-var prefix. Drizzle's `sql` expands a JS array as a tuple,
  not a Postgres array. `round(x, 2)` fails on `double precision` — cast to `::numeric`.
  `pnpm start -- -p 3011` passes `--` through literally; use `$env:PORT`.
- **A script named `doctor` silently collides with `pnpm doctor`** — it never ran and pnpm
  printed its own diagnostics instead. Check for a pnpm builtin before naming a script.
- Markdown **tables** convert badly into Google Docs via the Drive connector; lists are safe.

---

## 5. The next step I'd take

**In order:**

1. **Deploy.** Follow `DEPLOY.md` start to finish. Run `.\run.cmd check:deploy` after
   loading data — it verifies config, database, data, metrics freshness and every
   connector, and names the fix for anything wrong.
2. **Add the team** via `/team`, using the narrowest role that does the job.
3. **Re-sync Meta** the moment Sam clears the app block: `backfill --source=ads`, then
   `metrics`. That fixes the inflated conversion counts *and* unblocks the whole social
   engagement dashboard.
4. **Trace the free-acquisition route.** 306 of 877 mature Issue-05 quarterly subscribers
   have **no paid Shopify order at all**, and the mechanism isn't visible in
   `discount_codes` — a $0 selling plan? an automatic discount? a comp converted to a
   subscription? It's a third of that cohort and currently unexplained. Sam's context:
   Oct 2025 was a migration from a 4-issue Shopify product into Skio, where many
   subscribers never entered payment details and lapsed through dunning, plus free and
   discounted resubscription offers to previous buyers. **A list of those migrated
   customers, or the product ID / date range, would let us separate migration lapse from
   genuine churn** — they're currently one number, and it makes Issue 05 look far worse
   than it was.
5. **Then:** phase-10 validation pass, phase-11 advertiser reporting, AI insights + Slack.

**Blocked on someone else — don't guess these:**

- Real **per-copy print cost** (currently an unverified $11.48 placeholder). The single
  biggest unknown in the margin model; `/costs` shows exactly what it's worth and has a
  UI to enter it.
- **UTM tagging rollout** — the guide is written and delivered. Collapses attributed ROAS
  from a 0.15×–0.61× range to a single number.
- **Archive.com** credentials — Sam is starting that integration.
- **`read_reports` + Level 2** Shopify access — automates shipping cost.

---

## Headline numbers — quote these with their caveats, never bare

- Revenue (net, Shopify paid ex-VAT + Stripe): **$152,204**
- Ad spend **$29,524** · **MER 5.16** · aMER 2.54 · blended CAC **$7.72**
- CM1 $119,918 / CM2 **$92,169** / CM3 $62,645 — *paid-order boundary; `/profit` can show
  a different one on purpose*
- Attributed paid-meta ROAS **0.15×–0.61×** — a band, not a point estimate
- Quarterly plan loses **43.7% at the first rebill**. ⚠️ **1,981 of 3,468 subscriptions
  have never faced a renewal** — the annual plan is untested until ~Oct 2026, so don't
  present a base-wide renewal rate
- Best channel by retention: **newsletter** (~0% first-renewal churn, $113 LTV) vs
  **organic-social** (51.1%, $27) — which is also the *biggest* channel
- ⚠️ Meta's self-reported conversions are **stale and ~3× inflated** until re-synced

---

## Before you run anything

1. **You need a `.env`.** It is **not** in this handover — it holds live API keys. Get the
   values from Sam through a password manager or similar, never chat or email.
   `.env.example` lists every variable with notes.
2. **`node_modules` is not included either.** Run `.\run.cmd install`, or `pnpm install`
   if pnpm is already on your PATH.
3. **Ask Sam to rotate the Stripe and Skio keys** as he shares them. Both passed through a
   chat window during development and should be treated as exposed.

```powershell
.\run.cmd install
.\run.cmd check:deploy   # tells you exactly what's still missing
```

### ⚠️ `build` will fail until `.env` exists — with a misleading error

This handover was tested from a clean state, and this is the one thing that trips it up.
Without a `.env`, `.\run.cmd build` fails with:

```
Build error occurred
Error: Failed to collect page data for /api/health
```

That message has nothing to do with `/api/health`. The env schema validates at module
load and throws, and `/api/health` is simply the first route Next touches that imports the
database client. **Create `.env` and it builds cleanly.**

Verified from a fresh checkout with placeholder values: 218 tests pass, typecheck silent,
build clean across 17 routes. `.\run.cmd test` and `tsc --noEmit` both work *without* a
`.env` — only `build` and anything touching the database need one.

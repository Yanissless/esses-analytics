# START HERE — session handoff

**Written:** 21 August 2026 · supersedes the 11 August version of this file
**From:** Sam's build sessions (all on Windows)
**To:** the next Claude Code session — Sam's, or **Johnny's on his Mac**
**Commit this describes:** the head of `master`, working tree clean — `git log -1`
(chasing its own hash in this line only ever produces a stale one)

This is the file to read first. It answers, in order: what we're building, where the code
is, what's mid-flight, what already failed, and what I'd do next. Nothing is
half-finished — every check passes at this commit.

| File | What it's for |
|---|---|
| **`START-HERE.md`** | This file. The handoff. Current as of today. |
| **`DEPLOY.md`** | The go-live walkthrough, step by step, no assumed knowledge. **Has a Mac section at the top.** |
| **`CLAUDE.md`** | Auto-loaded by Claude Code. The 9 hard rules — each one exists because breaking it caused a real bug. |
| **`HANDOFF.md`** | The deep archive: ~70KB across 9 sessions, every failed approach with section numbers. Read on demand, never front to back. |

> **Naming note:** on Windows, `handoff.md` and `HANDOFF.md` are the *same file*. This
> file is the handoff; `HANDOFF.md` is the archive it points into. Don't create a
> lowercase `handoff.md` — it will silently overwrite the archive.

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
cohort churn by issue / promo / renewal date, behavioural personas for ad targeting, and
AI insights to Slack. Internal only, behind auth, on a hidden `esses.com` subdomain.

The governing principle throughout: **a number you know you can't trust is worth more
than one you wrongly believe.** Almost every page states its own coverage, boundary or
caveat in-line. Please keep that up — it's the reason this is more useful than the tool
it replaces.

**Immediate objective:** get a live version at `analytics.esses.com` that the team can
review and tweak. Johnny owns the deploy; Sam continues building and clearing the
external blockers.

---

## 2. Current state of the code

**Phases 1–10 of 11 are built.** Every major dashboard from the brief exists, plus the
validation pass. Phase 11 (advertiser delivery reporting) is the only one outstanding.

- **485 tests pass** · `tsc --noEmit` silent · lint **0 errors** (6 pre-existing
  unused-import warnings) · `build` clean across **28 routes** (the number `run.cmd build`
  prints, which includes `/_not-found`)
- Running against live data (2025-10-01 → 2026-08-20): 10,477 countable orders, $187,955
  net revenue, MER 5.16×. Full figures with their caveats at the foot of this file.
- **`run.cmd validate`** asserts 11 invariants against the live data and exits non-zero on
  an error, so it can gate a deploy. Same results on `/data`. Run it before quoting a
  figure to anyone outside the team.
- Git: **68 commits on `master`**, working tree clean, **no remote yet** — that's Part 1
  of `DEPLOY.md`. The history is worth reading; each message explains *why*, not what.
- Stack: Next.js 16 App Router (`middleware` is now `proxy.ts`) · TypeScript · Tailwind v4
  · Drizzle + Postgres 17 · Vitest · pnpm

⚠️ **`daily_metrics` is grained `(date, channel)` where `channel IS NULL` means blended.**
Every sum over it must filter on that. Forgetting reads ad spend at roughly **2×** and
halves MER — 562 rows cover 324 dates. Every query in `src/metrics` and `src/app` already
filters correctly; the trap is new ad-hoc queries. There is now a check for it.

### Pages

`/` Overview · `/profit` · `/marketing` · `/creatives` · `/social` · `/audience` ·
`/journeys` · `/content` · `/customers` · `/churn` · `/personas` · `/discounts` ·
`/forecast` · `/goals` · `/international` · `/costs` · `/shipping` · `/data` · `/team` ·
`/ask` · `/account` · `/login` · `/api/health` · `/api/sync` · `/api/refresh` ·
`/api/ai/ask` · `/api/creative-image/[adId]`

The nav groups these into seven items — five dropdowns, plus Ask and Forecast as plain
links. Sixteen flat links overflowed the header and put a horizontal scrollbar on the whole
document, which appears at the very bottom of the page, miles from the nav that caused it. Grouping is also a claim about what belongs
together: Social, Creatives, Audience, Attribution coverage and Content are five views of
one question. Costs, Shipping and Team sit under **Settings** — they are places you go to
*enter* something, not to read something.

**`/data`** — whether the data is actually current, and whether the updating works. Carries
the sync run log, per-source reliability over the last 20 runs, and the 11 validation
checks. Reliability separates **standing gaps** (a warning recurring across 3+ runs, e.g.
the missing `read_reports` scope) from **new problems**, because Shopify otherwise read as
16 partial runs in 20 — an 85% trouble rate that was two known conditions repeating, and
which would have buried anything genuinely new. No capability gate: everyone reading a
number needs to know how old it is.

**`/content`** — readership from GA4. The one question nothing else here can answer: every
other metric starts from an order, so an article read by 8,000 people who bought nothing
is invisible. Scoped to content metrics only, deliberately **not** attribution — GA4 runs
its own model, ours is built from orders, and nothing outside can adjudicate between them.
**Needs `GA4_PROPERTY_ID` + `GA4_CREDENTIALS_PATH`**; until then the page explains what is
missing rather than showing an empty table. `run.cmd check:ga4` names the specific mistake
when the connection fails, because Google returns the same 403 for several causes.

**`/creatives`** — campaigns and ads with cached thumbnail previews (651 stored), and
Meta's own attribution numbers alongside ours so the gap can be examined rather than
guessed at.

**`/ask`** is the AI analyst (Claude Opus 5): 24 read-only tools over the existing
`metrics/*` functions, no SQL. Gated on `requireUser()` — every role may ask — but the
*toolset* is filtered by capability, so a marketing user's agent genuinely cannot reach
margin or individual customers (11 of 24 tools). `run.cmd check:analyst` calls every tool
live and prints the boundary. Needs `ANTHROPIC_API_KEY`; without it the page says so and
nothing else is affected.

**`/audience`** — Instagram following against paying subscribers. Has real data as of
12 Aug (43,300 followers, 15 Jul – 11 Aug, reconstructed from a Meta export). Carries the
absolute totals, the indexed growth comparison, followers-per-subscriber, a lead/lag
profile, and an audience-versus-orders geography table. Correlates on **daily** changes
while there are too few weeks for a weekly read; it switches to weekly automatically at 12
points and always shows both bases.

**`/journeys`** — titled **Attribution coverage**; what attribution can and cannot see. A coverage page, deliberately not a
path explorer: 71% of countable orders have no non-internal touchpoint (mostly API
renewals and comps, which no tagging recovers), 23% are a single session, and 5.6% are
multi-touch. Where a journey is one session all four attribution models agree by
construction, so model choice only moves that 5.6%.

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

`order_profit` and `daily_metrics` are materialised. `order_profit` is the single source
of per-order costed margin — the Profit page once timed out resolving costs per line item
four times per load. **Anything that loads data must be followed by `metrics`.**

The margin boundary (which revenue classes bear cost) is a **live setting** on `/costs`,
not a constant. The same period legitimately reads +$85K, −$15K or −$30K depending on it.
Every margin figure in the UI names its boundary. Print COGS is still a **placeholder**
($11.48/copy) awaiting Sam's real number.

---

## 3. Files most likely to need touching next

Nothing is left mid-edit — the tree is clean and every check passes. These are the files
the *next* piece of work lands in:

| File | Why |
|---|---|
| `src/connectors/ads/meta.ts` | First thing to revisit once Meta is unblocked. Also where the API version is hardcoded (`v21.0`) — see §5. |
| `src/metrics/order-profit.ts` | The one home for cost logic and the `revenue_class` CASE. Any margin change starts here. |
| `src/metrics/margin-boundary.ts` / `.server.ts` | The live cost-boundary setting. Note the pure/server split — rule 6 in `CLAUDE.md`. |
| `src/metrics/churn.ts` | Cohort churn by issue / promo / renewal date. Read the header note on billing vs delivery cadence before changing anything. |
| `src/metrics/personas.ts` | 13 behavioural segments + Meta audience thresholds. Deliberately exports **counts only**, never contact lists. |
| `src/lib/auth/capabilities.ts` | Who can see what. Edit this, not individual pages. |
| `src/lib/shipping/rate-rules.ts` | The single shipping rate-rule predicate. Five copies had drifted before this existed. |
| `scripts/check-deploy.ts` | The preflight check. Its imports are deliberately lazy — see the comment. |
| `scripts/check-meta.ts` | The Meta diagnostic. Its remediation text is the current best knowledge; update it when Meta answers. |

### New this session

- **`run.sh`** — macOS/Linux twin of `run.cmd`, so every `.\run.cmd x` in the docs reads
  as `./run.sh x` on Johnny's Mac.
- **`DEPLOY.md` § "If you're on a Mac"** — the three shell differences that matter
  (`run.sh`, `export` instead of `$env:`, `curl` instead of `Invoke-WebRequest`).

### New 20–21 Aug 2026

- **The app updates itself.** Opening any page starts a sync when the data is stale, with
  nothing to click. Four gates in `lib/sync/auto-refresh.server.ts` stop that becoming a
  problem: in-flight (one sync at a time), never-run (a page view must not start an 8-minute
  backfill), **cooldown before staleness** — keyed on the last *attempt*, because a broken
  source never becomes fresh and staleness alone would retry on every page view and bill a
  third-party API each time — then staleness. The honest limit: it only runs while the app
  is open, which is *not* sufficient for Instagram, whose follower history Meta serves over
  a rolling 30 days and never republishes. The Vercel cron covers that once deployed.
- **An unauthenticated `/api/*` request now returns 401 JSON, not a redirect to `/login`.**
  A redirect handed a `fetch` the login page's HTML, so `.json()` threw and the refresh
  indicator said "Couldn't update data" when the truth was "you are signed out". The rule
  moved to `lib/auth/wall.ts` as a pure function, because the app's only security boundary
  had no tests behind it. Page routes still redirect exactly as before.
- **`run.cmd validate` — phase 10.** 11 invariants against live data, each tied to a
  failure that actually happened rather than a hypothetical. It closed the rollup identity
  exactly: `daily_metrics` $187,955.23 = Shopify paid $174,372.33 + Stripe $13,582.90, gap
  **$0.00** across 562 rows. That had been an assumption.
- **GA4 content connector** (`src/connectors/ga4/`) + `/content`. Handles four things GA4
  does that would quietly corrupt the numbers: the `(other)` bucket (day totals come from a
  second query with no page dimension, and per-page shares are withheld rather than
  estimated where it applied), query-string fragmentation, two rows mapping to one stored
  row, and the 48-hour reprocessing window. Needs credentials before it has data.
- **Skio sync went from 479s to 2.2s** (218×). `incrementalSync` was doing a full load; it
  now filters on `updatedAt` with a 6-hour overlap. It would have timed out against
  Vercel's 300s ceiling every single night.
- **Revenue reclassified.** `revenue_class` is now `paid` | `acquisition_gift` | `comp` |
  `prepaid_delivery`, defined once in `metrics/revenue-class.ts`. **Branch order is
  load-bearing** — the promo checks must precede the prepaid conditions, or every giveaway
  silently becomes a prepaid delivery again. Free first issue is an acquisition cost;
  win-back is a comp, not acquisition. CAC has a **toggle** (`metrics/cac-basis.ts`):
  marketing-only or with-free-issues, kept separate rather than blended.
- **Renewal forecast covers both systems** — Skio `next_billing_at` plus Stripe
  `current_period_end`. $11,053 of Stripe renewals had been invisible.
- **The annual plan was priced 3.8× too low** ($26.28 against a real $100), because Skio
  queues a quarterly delivery order against one annual charge and the price was being
  derived from average order value. Fixed with an explicit table in `metrics/plan-prices.ts`.
  Prices there are **ex-tax**.

### New 11 Aug 2026 (afternoon session)

- **`/ask` — the AI analyst.** `lib/ai/analyst.ts` (pure: prompt, tool registry, the
  `roleCanUseTool` predicate), `tools.server.ts` (24 read-only wrappers over `metrics/*`),
  `analyst.server.ts` (SDK tool-runner loop), `api/ai/ask` (SSE), `app/ask/`. Plus
  `scripts/check-analyst.ts` → `run.cmd check:analyst`.
- **`/audience` — follower vs subscriber growth.** New `social_audience` table (migration
  `0011`), `metrics/audience-growth.ts` (correlation on changes, lead/lag profile,
  `indexToBase`), `scripts/import-social.ts` → `run.cmd import:social`.
- **Hard rule 9** added to `CLAUDE.md`: never a dual y-axis; correlate changes not levels.
- `ANTHROPIC_MODEL` default corrected from the `claude-sonnet-4-6` placeholder to
  `claude-opus-5`, discharging the "confirm the model at build time" note in
  `.env.example`.

---

## 4. Everything tried that failed

The full list is `HANDOFF.md` §6. The ones most likely to waste your time:

### Blocked externally — don't retry

- ## ✅ **Meta ads API — UNBLOCKED 11 Aug 2026.** The enforcement action lifted the same
  day this file was written. Two consecutive `check:meta` runs pass: `/me` succeeds, the
  app resolves, the ad account reads `active`, `ads_read` + `read_insights` both present,
  all on the hardcoded v21.0. Not intermittent.
  - ⚠️ **The stored ad data is still wrong.** `ad_spend` stops at 2026-07-30 and the
    conversion counts are the ~3x-inflated set. Nothing is fixed until
    `backfill --since=2025-10-01 --source=ads` then `metrics` have run.
  - Everything below this line is the *superseded* diagnosis. It is kept because the
    reasoning is worth reading — in particular how the token-vs-app distinction was
    established — but **do not act on it.**

- ~~**Meta API is blocked at the APP level, not the token. CONFIRMED 2026-08-11: it's a
  Meta enforcement action, and there is nothing to rebuild.**~~ *(superseded — see above)*
  - Meta's own debugger reports the token **Valid: True** — System User, never expires,
    `ads_read` + `read_insights`, app **Esses Analytics** (`28698775013059115`), user
    `esses analytics sync`.
  - Ours returns OAuthException code **200** ("API access blocked"). A malformed token
    returns **190**. `/debug_token` fails too — and that endpoint answers even for expired
    tokens, which is what proves this isn't credential-shaped.
  - Ruled out: **a new token** from the same app (identical failure) and **an API version
    sunset** (identical code 200 on v20.0 → v26.0, including the v26.0 the debugger uses).
  - **The block landed between 30 Jul and 4 Aug 2026.** `sync_runs` holds exactly three
    Meta runs, all on 2026-07-30 — one success (6,195 rows) and two transient `code 2`
    failures. `ad_spend` covers 2025-10-01 → 2026-07-30 and stops dead.
  - Remediation is **Meta-UI only and order-dependent** — `HANDOFF.md` §5.2, or run
    **`run.cmd check:meta`** / `./run.sh check:meta`, which separates token / app / scope
    causes and prints the ordered fix.
  - ⚠️ **The tell that cost us a detour:** on `developers.facebook.com` the top-right
    button reads "My Apps" for a registered developer and **"Get Started"** if you've
    never registered — in which case every app URL silently redirects, *including app
    creation*. **Business Suite permissions do not register you as a developer.** Sam hit
    this and it looked like the app had been deleted. It hasn't.
  - An earlier plan in `HANDOFF.md` recommended rebuilding the app. It is marked
    **superseded** rather than deleted, because its reasoning is still worth reading.
    Do not act on it.
- **Instagram organic metrics — still blocked, and a DIFFERENT blocker from the ads one
  above.** Follower count, reach and per-post engagement need `instagram_basic`,
  `instagram_manage_insights`, `pages_show_list` and `pages_read_engagement`. All four are
  missing from the token and the app sees **0 Pages**. Requesting them is now actually
  possible (it wasn't while the app was blocked) and it is Meta-UI work.
  - ✅ **Business verification: DONE, 12 Aug 2026.** It was the gate on Advanced Access to
    these permissions. Nothing about the app's configuration needs further investigation —
    the remaining work is entirely account access, described next.
  - 🔑 **NOW BLOCKED ON: Business admin rights over System Users.** Sam cannot reach the
    System Users settings, and **both** remaining steps live there:
    1. Assign the Page to the System User `esses analytics sync` (Add Assets → Pages).
       This is what clears `Pages visible: 0`.
    2. Generate a **new** System User token carrying all six scopes.

    Whoever holds Business admin can do both in about five minutes. Find them at
    **Business Settings → Users → People**, which employees can usually read — look for
    the Admin role. This is a delegation problem now, not a technical one.
  - ⚠️ **Verification does NOT retroactively widen an existing token.** Confirmed by
    running `check:meta` immediately after verification cleared: identical output, all four
    scopes still missing. Token scopes are fixed when the token is minted, so nothing about
    this connector changes until step 2 above happens. Don't re-run `check:meta` expecting
    movement before then.
  - ⚠️ When that token is generated, tick **all six** scopes — the four above *plus*
    `ads_read` and `read_insights`. A token minted with only the new four fixes Instagram
    and silently breaks the ads sync repaired on 12 Aug.
  - ⚠️ **Granting the scopes will not backfill history.** Instagram's `follower_count`
    insight returns a rolling **~30-day window** — there is no endpoint for the follower
    count on an arbitrary past date. So a correlation against subscriber growth can only
    ever be built from numbers recorded as they happened.
  - That is why `/audience` reads a `social_audience` snapshot table with a `source`
    column, and why `run.cmd import:social` exists: a weekly number read off the
    Instagram app is a first-class input, and the charts state how much of the series was
    observed versus hand-entered.

- **ShopifyQL `shipping_labels`** needs `read_reports` *and* Level 2 protected customer
  data access. Deliberately non-fatal — shipping falls back to rate-rule estimates.

### Bugs that passed every test

- **Ingest mapping a field the GraphQL query never requested.** Silent NULLs, no error
  anywhere. Hit twice in one query — order country and presentment currency. **When a
  column is unexpectedly all-NULL, check the query before suspecting permissions.** Two
  sessions blamed Shopify's permissions; the field simply wasn't being asked for.
- **`revenue_class` duplicated into four copies**, two missing the
  `customer_has_subscription` branch — so prepaid subscription deliveries were classified
  as free comps for several sessions. See rule 1.
- **Summing Meta's overlapping purchase action types** — inflated conversions ~3×. Caught
  by one sanity check: a platform can't drive more purchases than the store received. The
  test that encoded the bug had to be rewritten too.
- **AOV over all orders — twice.** 65% of orders are $0. $18.57 vs $53, and Instagram
  $13.59 vs $45.27.
- **`sum(DISTINCT revenue)`** silently collapses two orders of equal value. Needs a
  `DISTINCT o.id` CTE instead.
- **Trusting a stale `order_profit`** — I mis-diagnosed a 135-order gap as a missing
  `processed_at` filter; `metrics` simply hadn't been re-run. §4.11 has the correction.
- **A client component importing a DB module — twice** (`/costs` boundary form,
  `/forecast` goal form). `tsc` passes. Only `build` catches it. Rule 6.

### Tooling gotchas

- PowerShell has no inline env-var prefix (`FOO=bar cmd` fails). Drizzle's `sql` expands a
  JS array as a **tuple**, not a Postgres array — so `ILIKE ANY(${arr})` breaks; use one
  `~*` regex. `round(x, 2)` fails on `double precision` — cast `::numeric`.
  `pnpm start -- -p 3011` passes `--` through literally; use `$env:PORT`.
- **A script named `doctor` silently collides with `pnpm doctor`** — it never ran and pnpm
  printed its own diagnostics instead. Check for a pnpm builtin before naming a script.
  It's now `check:deploy`.
- `check-deploy` initially crashed on a broken config because a static env import threw
  before it could print anything. Its imports are lazy on purpose.
- Markdown **tables** convert badly into Google Docs via the Drive connector (literal
  `\*\*bold\*\*`); lists are safe. The connector is create/read only — **three stray docs
  need manual deletion**: the first UTM guide, "Esses Analytics — Meta &amp; Archive Setup
  Instructions", and the first "Going Live" doc.
- `Compress-Archive` **silently skips `.git`** (hidden on Windows). The handover zip uses
  `ZipFile.CreateFromDirectory` with `includeBaseDirectory:true`.

---

## 5. The next step I'd take

### Waiting on Sam — nothing else unblocks these

| Needed | Unblocks |
|---|---|
| **GA4 Property ID + service-account key path** (send the *path*, never the file contents; keep the key outside the project folder) | `/content` — the whole readership picture |
| **Real per-copy COGS** + the UK printer-park cost | Every margin figure. Print COGS is still a **$11.48 placeholder** |
| **`read_reports` + Level 2** customer-data access on the Shopify app | Automatic shipping-cost sync. Currently a standing gap on every Shopify run |
| **`ANTHROPIC_API_KEY`** — needs an org admin to approve the request, or a new org | `/ask`, the AI analyst |
| **A developer for the esses.com capture brief** (`docs/esses-com-attribution.md`) | Attribution on the editorial site |
| **UTM tagging rollout** by the social manager | Collapses the ROAS band to one number |

### Buildable now, in order

1. **Deploy.** `DEPLOY.md` start to finish (Mac section first). Then
   `check:deploy` — it verifies config, database, data, metrics freshness and every
   connector, and names the fix for anything wrong. The nightly cron in `vercel.json` is
   what makes the auto-refresh sufficient rather than best-effort, so this is the highest
   value item on the list.
2. **Add the team** via `/team`, using the narrowest role that does the job.
3. **Phase 11 — advertiser delivery reporting.** The last one from the brief. Needs a
   conversation about what an advertiser is actually promised before any code: impressions,
   readership, or something else. Don't guess this.
4. **The 45 subscriptions with no selling-plan name** (surfaced by `run.cmd validate`).
   They fall to the derived-from-MRR pricing path, which is exactly how the annual plan
   came out 3.8× low. Worth naming them properly.
5. **YoY comparison columns** — blocked until ~Oct 2026 by data history, not by code. An
   empty column that silently fills in later is worse than no column.
3. ~~**Re-sync Meta**~~ ✅ **DONE 11 Aug 2026.** `backfill --since=2025-10-01 --source=ads`
   then `metrics`. 6,774 rows, window now to 11 Aug. On identical dates spend held steady
   (+0.4%, late-attribution settling) while platform conversions fell **8,116 → 2,039**,
   a 3.98x reduction — so the only thing that changed is the overlapping-action-type
   dedup, which is what should have changed. The sanity ceiling now passes: 2,412
   conversions against 2,768 real paid orders. Headline numbers restated at the foot of
   this file.
   - The ROAS band needed no code change: `/marketing` computes it live from
     `attribution/reconciliation.ts`, so it was never showing a stale figure — only this
     file was. It now reads **0.13x–0.53x**. What the re-sync actually fixed is the
     reconciliation *narrative*: Meta's claim is now 11.7x our provable count rather than
     larger than the store's entire order book.
   - Followed by `run.cmd sync` to bring orders level with ad spend, because the backfill
     had left a week of spend with no orders to earn against — see the note at the foot of
     this file.
   - This did **not** unblock the social engagement dashboard or `/audience` — those need
     the four Instagram/Pages scopes, a separate grant, still missing (§4).
4. **Trace the free-acquisition route.** 306 of 877 mature Issue-05 quarterly subscribers
   have **no paid Shopify order at all**, and the mechanism isn't visible in
   `discount_codes` — a $0 selling plan? an automatic discount? a comp converted to a
   subscription? It's a third of that cohort and currently unexplained.
   Sam's context: Oct 2025 was a migration from a 4-issue Shopify product into Skio, where
   many subscribers never entered payment details and lapsed through dunning, plus free and
   discounted resubscription offers to previous buyers. **A list of those migrated
   customers, or the product ID / date range, would let us separate migration lapse from
   genuine churn** — they're currently one number, and it makes Issue 05 look far worse
   than it was.
5. **Get follower numbers into `/audience`.** The page, the table, the correlation and the
   charts are built and tested; they have nothing to draw. Two ways in, and they compose:
   request the four Instagram scopes for the live feed going forward, and import whatever
   history exists via `run.cmd import:social` — 12 weekly readings is the point at which
   the correlation starts to mean anything. Without history there is no correlation to
   compute, scopes or no scopes.

6. **Then:** phase-10 validation pass, phase-11 advertiser reporting, the AI insights
   *digest* to Slack (the interactive half now exists at `/ask`; the scheduled push does
   not, and needs `SLACK_BOT_TOKEN`).

**Small and offered but not yet approved:** make the Meta Graph API version configurable
via env — it's hardcoded `v21.0` in `src/connectors/ads/meta.ts`. Not the current problem,
but v21.0 will sunset eventually and right now that's a code change rather than a setting.

**Blocked on someone else — don't guess these:**

- Real **per-copy print cost** (currently an unverified $11.48 placeholder). The single
  biggest unknown in the margin model; `/costs` shows exactly what it's worth and has a
  UI to enter it.
- **UTM tagging rollout** — the guide is written and delivered to the social manager.
  Collapses attributed ROAS from a 0.15×–0.61× range to a single number.
- **Archive.com** credentials — Sam is starting that integration.
- **`read_reports` + Level 2** Shopify access — automates shipping cost.
- **Meta unblock** — Meta's UI only, see §4.

---

## 6. Picking up in a new session

Paste this to a fresh Claude Code session:

> Read `START-HERE.md`, then `CLAUDE.md`, then `git log -1` to see where we are.
> Clean tree, 274 tests passing. I'm doing <the thing>. Meta's *ads* API access is back
> (11 Aug) but the stored ad data is still the stale ~3x-inflated set; Instagram organic
> metrics are still scope-blocked — don't try to fix either in code.

Then:

```bash
./run.sh install
./run.sh check:deploy
```

(Windows: `.\run.cmd install`, `.\run.cmd check:deploy`.)

### Before you run anything

1. **You need a `.env`.** It is **not** in this handover — it holds live API keys. Get the
   values from Sam through a password manager or similar, **never chat or email**.
   `.env.example` lists every variable with notes.
2. **`node_modules` is not included either.** Run `./run.sh install`.
3. **Ask Sam to rotate the Stripe and Skio keys** as he shares them. Both passed through a
   chat window during development and should be treated as exposed.
4. **Set your own git identity before your first commit**, or it fails with "Author
   identity unknown". The existing commits were authored explicitly rather than from a
   global config, so there's nothing set in this repo — deliberately, so your commits are
   attributed to you and not to Sam:

   ```bash
   git config user.name "Johnny <surname>"
   git config user.email "johnny@essesmag.com"
   ```

### ⚠️ `build` will fail until `.env` exists — with a misleading error

This handover was tested from a clean state, and this is the one thing that trips it up.
Without a `.env`, `build` fails with:

```
Build error occurred
Error: Failed to collect page data for /api/health
```

That message has nothing to do with `/api/health`. The env schema validates at module
load and throws, and `/api/health` is simply the first route Next touches that imports the
database client. **Create `.env` and it builds cleanly.**

Verified from a fresh checkout with placeholder values: 274 tests pass, typecheck silent,
build clean across 20 routes. `test` and `tsc --noEmit` both work *without* a `.env` —
only `build` and anything touching the database need one.

---

## Headline numbers — quote these with their caveats, never bare

**Restated 21 Aug 2026, window 2025-10-01 → 2026-08-20**, from the blended row of
`daily_metrics` (`channel IS NULL`) and cross-checked by `run.cmd validate`, which now
closes the identity exactly: rollup $187,955.23 = Shopify paid $174,372.33 + Stripe
$13,582.90, gap **$0.00**.

⚠️ **Two ways these figures have gone wrong before, both worth checking first if a surface
disagrees.** (1) A sum over `daily_metrics` that forgets `channel IS NULL` reads ad spend
at **2×** and halves MER — that produced a bogus "MER 2.58×" while gathering these very
numbers. (2) `ad_spend` running past the last synced order makes a page clip to the order
window while `metrics` uses the wider one; check `max(processed_on)` against
`max(ad_spend.date)`.

- Revenue (net, Shopify paid ex-VAT + Stripe): **$187,955**
- Ad spend **$36,440** · **MER 5.16×** · blended CAC **$8.36** (4,357 new customers)
- CM3 **$73,058** · CM3 **38.9%** — *paid-order boundary; `/profit` can show a different
  one on purpose, and print COGS is still a $11.48 placeholder, so margin is overstated
  wherever a unit has no cost record.*
- **10,477 countable orders**, 9,711 in the rollup window
- By revenue class: **paid 3,675** · prepaid_delivery 4,342 · acquisition_gift 1,694 ·
  comp 766. The last two are giveaways — free first issue is an *acquisition cost*, VIP
  and win-back copies are *comps*. CAC has a toggle for whether to include them.
- Attribution covers **89.5%** of paid orders (3,288 of 3,675) with a converting touchpoint
- Instagram: **44,048 followers**, 38 days of history, largest daily move 392
- Attributed paid-meta ROAS **0.13x–0.53x** — a band, not a point estimate. Floor is what
  we can prove; ceiling assumes every ambiguous untagged social order was Meta's. UTM
  tagging collapses it to one number.
- Meta's own claim: **2,449** conversions at ROAS 0.71x, against **209** we can
  corroborate and 1,309 more that are plausible-but-unprovable — so it claims 11.7x our
  count and a 2,240-conversion gap stays unexplained. That gap is view-through and
  cross-device, which we have no way to observe. **This is now a credible disagreement
  rather than an impossible one:** pre-re-sync Meta claimed 8,116 conversions in a window
  where the store took fewer orders in total. Treat its ROAS as its own claim.

*Superseded (pre-re-sync, window to 30 Jul): revenue $152,204 · ad spend $29,524 · MER
5.16 · aMER 2.54 · CAC $7.72 · CM1 $119,918 / CM2 $92,169 / CM3 $62,645 · Meta conversions
8,116 · ROAS band 0.15x–0.61x. Kept for one release so a figure quoted last week can be
traced rather than looking like a mistake.*
- Quarterly plan loses **43.7% at the first rebill**. ⚠️ **1,981 of 3,468 subscriptions
  have never faced a renewal** — the annual plan is untested until ~Oct 2026, so don't
  present a base-wide renewal rate
- Issue 04 → 05 first-renewal churn **14.7% → 50.1%** *within the Quarterly plan*, so it
  isn't a plan-mix artefact. Cause is acquisition composition: 68.3% organic-social vs
  27.7%, plus the 306 unexplained free subscriptions above
- Best channel by retention: **newsletter** (~0% first-renewal churn, $113 LTV) vs
  **organic-social** (51.1%, $27) — which is also the *biggest* channel
- ⚠️ Meta's self-reported conversions are **stale and ~3× inflated** until re-synced

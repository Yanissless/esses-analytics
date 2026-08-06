# Esses Analytics — Session Handoff

**Last updated:** 2026-08-06 (session 8)
**Project root:** `C:\Users\samwi\esses-analytics`
**Status:** Phases 1–8b built, plus Marketing/reconciliation, Churn & cohorts, Social
and Personas, with a live margin-boundary setting and COGS sensitivity/coverage.
189 tests pass, typecheck + build clean, all 13 routes render against live data.
Git baseline exists (§4.9).

⚠️ **Read §5.2 before touching Meta.** Access is blocked at the APP level — a new
token will not fix it. Sam is working on the unblock.

---

## 1. The goal

Build an internal sales/marketing/customer-value analytics app for **Esses Media**
(F1 & motorsport magazine, subscription e-commerce) to replace **StoreHero.ai** —
something Esses owns and can extend.

Match StoreHero's core capability, then go further on the one thing it can't do:
**unify customer LTV across every revenue source**.

Revenue comes from three places and they must never be double-counted:

| Source | Role |
|---|---|
| **Shopify** | Single source of truth for ALL order revenue (one-time *and* Skio subscription orders) |
| **Skio** | Enrichment ONLY — plan, status, churn, MRR. Never a second source of order revenue |
| **Stripe** | Fully separate, additive stream — print + digital subscriptions, split by `subscription_line` |

Target capabilities: daily sales/profit dashboard, marketing performance, profit-first
metrics (MER/aMER/CAC/CM1-3), forecasting vs goals, AI insights to Slack, and unified
LTV/cohorts. Internal-only, behind auth, on a hidden `esses.com` subdomain.

Full brief lives in the original project spec (14 sections). Build phases 1–11.

---

## 2. Environment (matters — this machine has quirks)

- **Node 24 LTS**, **pnpm**, **PostgreSQL 17** all installed *during* the first session.
- ⚠️ **PATH quirk:** any shell started before those installs doesn't have `node`/`pnpm`.
  The app's Run button hits this. **Use the launcher instead:**
  ```
  C:\Users\samwi\esses-analytics\run.cmd <script>
  ```
  It injects `C:\Program Files\nodejs` + `%APPDATA%\npm` then forwards to pnpm.
- **Postgres:** service `postgresql-x64-17` on `localhost:5432`. Superuser `postgres`
  password `postgres` (winget default). psql at
  `C:\Program Files\PostgreSQL\17\bin\psql.exe`.
- **App DB:** `esses_analytics`, owned by role `esses_app`. Connection string in `.env`.
- ⚠️ **pnpm v11 build scripts:** approve native builds in `pnpm-workspace.yaml` under
  `allowBuilds:` (a package→boolean map). NOT `onlyBuiltDependencies`, NOT the
  `package.json` "pnpm" field.
- Scripts run via `tsx` use **relative imports** (`@/*` is Next-only).
- ⚠️ **A stale `next` server from an earlier session may still hold port 3000**
  (one was found running from the previous day, serving an old build with no
  `/marketing` route — a 404 that looks like a code bug but isn't). To test a fresh
  build without disturbing it: `$env:PORT="3011"; run.cmd start`.

### Key commands
```bash
run.cmd check:shopify      # verify Shopify auth + scopes (4 independent checks)
run.cmd check:ads          # verify Meta, samples 7 days before writing
run.cmd sync               # incremental all sources + rebuild rollup
run.cmd backfill --since=2025-10-01 --source=shopify|skio|stripe|ads
run.cmd metrics            # rebuild order_profit + daily_metrics, print summary
run.cmd attribution [--inherit]   # channel performance across all 4 models
run.cmd restamp            # re-derive customers.acquisition_channel
run.cmd review             # flagged-order review queue with customer context
run.cmd import:shipping --file="...csv"
run.cmd test / build / start
```

---

## 3. Current state of the code

### Stack
Next.js 16 (App Router) · TypeScript · Tailwind v4 · Drizzle ORM + Postgres · pnpm ·
Vitest. Auth is self-owned: jose-signed session cookies + bcryptjs, `proxy.ts` gates
every route (Next 16 renamed `middleware` → `proxy`). The gate is **deny-by-default**,
so a new route needs no allowlist entry.

### Live data loaded (since 2025-10-01)
- **Shopify:** 8,357 orders, 47 products / 102 variants, fulfilments
- **Order countries now populated:** US 7,597 · GB 347 · AU 68 · CA 65 · DE 26 …
  only **85 orders (1%)** have no country at all
- **Skio:** 3,241 subscriptions (enrichment only)
- **Stripe:** 223 subscriptions, $7,466 paid — all currently `print`
- **Meta:** 6,195 ad-day rows, **$29,523.85** spend (⚠️ conversion counts stale — §5.2)
- **Shipping:** 5,462 labels / $46,309 attributed from Shopify's label report
- **Attribution:** ~3,600 touchpoints, 2,119 of 7,995 orders covered (40.7%)

### Pages (all behind auth)
`/` Overview · `/profit` · `/marketing` · `/social` · `/customers` (LTV/cohorts) ·
`/churn` · **`/personas`** (new) · `/international` · `/costs` · `/shipping` ·
`/login` · `/api/health`

### Architecture notes worth knowing
- **`order_profit` is the materialised single source of per-order costed margin**
  (`src/metrics/order-profit.ts`). Rebuilt by `rebuildDailyMetrics()`.
- **Cost resolution order (do not change casually):** COGS = `product_costs` row for
  `(sku, origin)` with greatest `effective_date <= order date`, falling back to origin
  `'default'`, then a synthetic `variant:<uuid>` key. Shipping =
  **actual invoice > per-label rate rule > zone average**, with `ship_basis` recording
  which was used.
- **Ratio convention:** every ratio returns **`null`**, never 0 or Infinity, when the
  denominator is 0 — renders as "—". `cac()` deliberately returns null at zero spend.
- ⚠️ **Rate-rule matching SQL is duplicated in FOUR places** and must stay identical:
  `metrics/order-profit.ts`, `metrics/rollup.ts`, `metrics/cogs.ts`,
  `lib/shipping/match.ts` (twice). Worth consolidating — see §7.

---

## 4. What changed this session

### 4.1 ✅ FIXED — §5.1 shipping mis-pricing. Root cause was NOT what we thought.

The previous handoff blamed `country_code = NULL` on derived international rate rules.
That was *a* bug, but the dominant cause was much simpler and much bigger:

> **`ORDERS_QUERY` never requested `shippingAddress` / `billingAddress`.**
> `ingest.ts` mapped `node.shippingAddress?.countryCodeV2 ?? null` faithfully — of a
> field the query never asked for. **Every one of 8,303 orders had country NULL.**

Consequences, all now fixed:
- the `market_config` join matched nothing → **every order fell to zone `row`, VAT 0%**
- every `country_code = 'US'` rate rule was **unreachable**, so the good domestic rules
  (USPS $4.47, UPS $7.60) never fired and international rules won by default
- `/international` had one bucket; VAT was never applied to any order

Verified against the live API first: **the address fields read fine on the current
token/scopes** — this was never a permissions problem (unlike ShopifyQL, §6).

**Measured effect** after re-backfill + `run.cmd metrics`:

| | before | after |
|---|---|---|
| prepaid `rate_rule` shipping / unit | **$27.88** | **$7.23** |
| prepaid shipping total | $82,359 | **$35,265** |
| prepaid orders in the $20.71–$39.36 band | 2,074 | **42** |
| zone mix | 100% `row` | us 7,442 · uk 209 · eu 90 · row 254 |

That meets the prediction in the old §5.1 ("should drop toward the observed ~$4.40
Media Mail rate"): prepaid shipping/unit is now **$5.92** all-in.

Also fixed alongside it (same query/ingest mismatch): `presentmentCurrencyCode` and
`totalPriceSet.presentmentMoney` were mapped but never requested, so
`presentment_currency` / `presentment_total_amount` were always NULL. Now populated —
8,357 orders across 18 currencies.

Secondly, the **original** §5.1 bug is fixed too, since it's still latent once country
works: derived "international" rules carry `exclude_country_code = 'US'` (new column,
migration `0006`), so a US shipment on a carrier with no domestic rule can't inherit an
international rate. Applied in all four matching sites.

### 4.2 ✅ Built — `/marketing` + the reconciliation surface (brief §8.4)

New `src/attribution/reconciliation.ts`:
- `getPlatformReconciliation()` — per platform: spend, platform-claimed conversions and
  value, our attributed conversions and revenue, both ROAS/CAC readings, and the
  **ambiguity band**.
- The band is the useful part. Untagged Meta clicks land in `organic-social`, so
  `ambiguous*` counts orders whose touchpoints came from Meta hosts with **no click id**.
  Our attribution is the floor, ours + ambiguous is the ceiling. Currently
  **ROAS 0.15× – 0.61×** — note even the ceiling is under 1.0.
- `getPlatformTrend()` — monthly platform-reported spend/conversions.
- Nothing reclassifies anything; it reports the uncertainty instead of resolving it,
  because resolving it needs tagged links, not a better guess.

`/marketing` page: blended MER/aMER/CAC/breakeven headline, the reconciliation panel,
channel table with **model toggle** (4 models) and **basis toggle**
(session-only / inherit-from-customer) via search params, coverage card, Meta trend.

### 4.3 ✅ FIXED — Meta conversions were double-counted ~3×

`sumPurchaseActions()` **added** `omni_purchase` + `purchase` +
`offsite_conversion.fb_pixel_purchase` + `web_in_store_purchase`. Those are overlapping
*views of the same conversion*, not separate events — `omni_purchase` is Meta's
deduplicated cross-channel total and already contains the pixel subset.

Proof from stored data (no API needed): Meta claimed **8,116 purchases against 2,766
paid orders**, and on **148 of 177 days** claimed more conversions than the store took
orders *from every channel combined* — on 2026-04-28, **208 claimed against 2 actual**.

Replaced with `pickPurchaseAction()`: takes the **first type present** in a priority
order, never adds types, but does sum repeated entries of the *same* type (breakdown
rows). Three new tests pin it, including "never adds overlapping purchase types".

⚠️ **The stored `ad_spend` rows are still inflated** — they were written by the old
code, and `META_ACCESS_TOKEN` currently returns **"API access blocked"** so they can't
be re-synced. See §5.2.

Rather than let the page render an impossible number as fact, `PlatformReconciliation`
now carries a **`claimExceedsAllOrders` guard** (platform conversions > total store
orders in the window). When it trips, `/marketing` shows a red banner naming the cause
and the fix, blanks the platform-side stats, and falls back to reporting only what our
own attribution can support. The guard is a permanent correctness check, not a
workaround — it should stay after the re-sync.

### 4.4 ✅ FIXED — breakeven MER mixed two margin boundaries

While building the page: `getProfitWaterfall()` uses the **excluding-comps** boundary
(currently a *negative* CM2), while MER's numerator comes from `daily_metrics`, which
uses the **paid-order** boundary. Feeding the waterfall's margin into `breakevenMer()`
rendered "Breakeven MER —" beside a 5.15× MER, implying advertising could never pay for
itself. Now uses `period.cm2Cents / period.revenueCents` — the same base as MER —
giving **breakeven 1.65× at 60.6% margin** against MER 5.15×.

⚠️ **This divergence is real and still there:** `/profit` and `/` legitimately report
different CM2 for the same period because they draw the boundary differently. It's
documented in each place, but see §5.1.

### 4.6 ✅ Built — cohort churn engine (`src/metrics/churn.ts`) + `/churn` page

Sam asked for churn specific to **issue / promo / renewal date**, with customer
cohorts grouped so each factor's effect is visible. Built as ONE cohort engine with
a dimension parameter rather than three unrelated functions, so every cohort is
comparable on identical denominators:

- `getChurnCohorts(dimension)` — `issue_at_signup` | `issue_purchased` | `promo` |
  `plan` | `signup_month` | `channel`
- `getRenewalCycleChurn({planName, cycleMonths})` — churn at each rebill
- `getIssueWindows()`, `getPlanCadences()` — the derived inputs, exposed so the
  cohorting is auditable rather than magic
- Pure helpers unit-tested separately: `isMarketingPromo`, `parseIssueNumber`,
  `isPreOrderTitle`, `billingCycleMonths`, `cyclesReached` (19 new tests)

**Two correctness rules the whole module rests on — do not "simplify" these away:**

1. **Maturity denominators.** Raw churn % is not comparable across cohorts: a cohort
   acquired last month cannot have churned at renewal yet. `churnByFirstRenewalPct`
   is measured only over subscriptions old enough to have FACED a first renewal, and
   `matureSubscriptions` publishes that denominator. Same class of trap as the cohort
   LTV illusion already documented in §6.
2. **Renewal cadence ≠ delivery cadence.** ⚠️ Note the deliberate asymmetry with MRR:
   `lineMrrCents` uses the DELIVERY cadence because that's what spreads revenue;
   churn uses the **BILLING** cadence because that's when a human can stop paying.
   Same two Skio fields, opposite choice, on purpose.

**New data captured:** `orders.discount_codes text[]` (migration `0007`) — we stored
discount *amounts* but never the *code*, so promo churn was unanswerable. Added
`discountCodes` to `ORDERS_QUERY`, re-backfilled: 8,501 orders synced, 3,274 carry a
code. Real campaigns now visible: `FREEFIRSTISSUE`, `ESSES1YEAR`, `BLACKFRIDAY50`,
`SUBSCRIBE25`, `HOLIDAY25`, `GIFT25`, `freeship75`.

⚠️ **Two promo traps, both handled.** Codes appear on prepaid $0 subscription
deliveries too (`FREEFIRSTISSUE` zeroing a $30 renewal), so promo cohorting reads the
**acquiring PAID order only** — otherwise one acquisition promo gets credited with
every later shipment. And Shopify's code list mixes marketing with operations:
`Cancel flow discount` is a **save offer made during cancellation**, so scoring it as
an acquisition promo reports the causality backwards. `isMarketingPromo()` excludes
those, and its patterns are the single source generating the SQL regex too.

### 4.7 ✅ Delivered — UTM tagging guide for the social manager

Google Doc: **https://docs.google.com/document/d/1drIUn6HEdYkrc8OhqJvAPq5eJtyFCdKHk5Kg0TEdcfE/edit**

Written for a non-technical reader, but the values in it are the ones
`resolveChannel()` actually matches — that's the "integrate correctly" part. Includes
the Meta Ads Manager `URL parameters` one-time setup using `{{site_source_name}}`
(resolves to `ig`/`fb`, both recognised), so paid tagging needs no per-ad work.

⚠️ An earlier attempt at the same doc is also in Sam's Drive titled *"Esses — UTM
Tagging Guide (for social manager)"* — its markdown tables converted badly (literal
`\*\*Where\*\*` in cells). **That one should be deleted;** the link above is the good
one. The Drive connector is create/read only, so it could not be edited or removed.

**Classifier change to make the guide true:** `resolveChannel()` previously read
`utm_source` only for PAID detection, so the organic tags the guide asks for would
have been ignored. Added `ORGANIC_MEDIUMS` and organic `utm_source` matching — placed
strictly AFTER the paid checks so a tagged paid click can never be demoted to organic
(pinned by a test). This is forward-looking only: UTMs are null on all existing
touchpoints, so no re-ingest was needed.

### 4.8 ✅ Built — Social module (`src/metrics/social.ts`) + `/social` page

Deliberately **not** a Later/Sprout clone. Platform-side engagement — followers,
reach, engagement rate, per-post metrics — lives only in the Instagram Graph / TikTok
APIs, needs its own connector plus a working Meta token, and is in no table here.
`SOCIAL_PLATFORM_METRICS_GAP` names those four gaps and the page states them outright
rather than rendering empty tiles.

What it does instead is the half those tools can't: follow a social visit through to
revenue, retention and margin, with paid and organic on the same commerce outcome.

- `getSocialSummary()` — social-touched revenue and its share, paid vs organic-only
  orders, spend, coverage
- `getSocialPlatformPerformance()` — per platform; **works today with no UTM tagging**
  because platform comes from the referrer host with Shopify's `source` as fallback
- `getPaidCampaignPerformance()` — Meta campaign spend/CTR/CPC/CPM joined to the orders
  its tagged visits reached
- `getSocialLandingPages()` — best available proxy for "which post worked" pre-`utm_content`
- `getTaggedCampaigns()` — campaign tagging health; the readiness check for the rollout
- `normalizeSocialPlatform()` pure + unit-tested (7 new tests)

**The ads↔commerce join is the interesting bit.** Meta writes the campaign ID into
`utm_campaign` while hand-tagged links carry the name, so the join matches on
**either** — matching one silently loses most of the data.

Findings worth acting on:
- Instagram dominates: 1,366 touchpoints, 1,103 orders, **$14,985** revenue, AOV $45.27.
  Facebook is 90 touchpoints. TikTok/Threads are ~3 combined.
- **Social-touched revenue is $19,021 — 13.1% of all revenue**, and 1,130 of 1,335
  social orders had **no paid touch at all**. Organic carries this channel.
- ⚠️ But organic-social is the **worst retention cohort** (51.1% churn by first renewal,
  $27 LTV — §5.6). Volume and quality point opposite ways; that tension is the most
  useful thing on the page.
- **$8,462 of Meta spend has no identifiable visit** ("Substack Newsletter Campaign"
  $1,689, "Austin 2025 eventbrite" $1,492, "Editorial Ads" $1,322, "TAG Ad" $883…).
  Several are clearly awareness buys (CTR 0.1%, CPM $0.64) — a measurement gap, not
  proof of zero performance.
- Only two campaigns clear ROAS 1.0 on matched data: "Issue 3 - TOF - ABO – Copy"
  (1.28) and "BFCM Statics" (1.18). Recent Issue 05/06 campaigns read 0.09–0.11 —
  **but they drove free/discounted signups**: Issue 05 attributed 76 orders at ~$9.53
  each. Read `attributedOrders` against `attributedPaidOrders` before concluding a
  campaign failed.

### 4.9 ✅ Baseline git commit made

`9c05504` — 159 files, 47,790 insertions, on `master`, **nothing pushed** (no remote).
Committed to `master` rather than a branch because it's the initial baseline of a repo
with zero prior history; branching would have left the default branch empty.

Pre-commit checks done: `.env` confirmed gitignored, `.env.example` verified to hold
placeholders only, and a regex sweep for `shpat_` / `sk_live_` / `EAA…` / `xoxb-` /
`sk-ant-` patterns across the whole tree returned nothing.

⚠️ No global git identity was configured on this machine, so the commit was authored as
`Sam Williams <sam@essesmag.com>` via inline `-c` flags. **Correct the display name if
that's wrong**, and consider `git config --global user.name/email` so future commits
don't need it.

### 4.10 ✅ Built — behavioural personas (`src/metrics/personas.ts`) + `/personas`

Driven by Sam's targeting doc, whose own research concluded that Meta age/gender
targeting costs 2–3× per placement and acts as an exclusion filter, and that
hyper-specific **creative** is what performs because Advantage+ reads the copy and
targets on signals Meta won't let you select. So personas here are **behavioural**:
we hold no age/gender/income/interest data, and behaviour is both the better creative
brief and the only thing that can seed a Custom Audience → Lookalike.

13 segments, each defined by an observable action with the definition shown on the
page so any row is auditable: collectors, annual committers, quarterly triallers,
full-price, discount-dependent, merch buyers, gift givers, event/community,
single-issue tryers, top-decile, international, US core, lapsed subscribers.
`getPersonaProfiles()`, `getSegmentOverlap()`, `getGeoConcentration()`.
`classifyProductTitle()` is pure + tested (8 new tests) and shares its patterns with
the SQL via exported constants, same discipline as `OPS_DISCOUNT_SQL_REGEX`.
Reuses `SUBS_CTE` exported from churn.ts rather than reimplementing cadence logic.

**Headline findings:**
- **Full-price buyers are the best Lookalike seed**: 1,671 customers (73.6% of
  paying), LTV **$71.04**, and the only high-quality segment over Meta's 1,000
  contactable floor. Top-decile is the ideal customer (LTV **$177.82**, 9.4% churn)
  but only 229 contactable — too small to seed a Lookalike.
- **Discount-dependent customers churn 3.6× worse**: 73.1% by first renewal vs 20.5%
  for full-price. ⚠️ n=26 mature so it's a lead, but full-price's 20.5% rests on
  n=655 and is solid. **Exclude them from Lookalike seeds** — that seed would find
  more of the wrong people.
- ⚠️ **This refines, not contradicts, §5.6.** A promo at acquisition is fine (some
  codes retain *better* than no-code). Customers who *only ever* buy on a discount
  are the problem. Different definitions, both true.
- **390 single-issue tryers** (17.2%) bought once at full price and never subscribed —
  98.5% overlap with full-price, 380 contactable. Cheapest identified upside.
- **The UK buys bigger but is worth less**: AOV $89.92 vs US $51.33, yet LTV $32.07 vs
  US $67.96. One large order, no repeat — a retention problem, not an acquisition one.
  CA ($97.97 LTV) and AU ($91.22) look stronger than GB but on 18 customers each.

**Known limitation:** the event/community segment resolves to only 2 paying customers
because event products (Austin guide 147u, Miami tee 49u, event patches) went out
almost entirely as **$0 comps**, and segments are built over paid orders. The cohort is
real but invisible to this method — needs the comp orders included deliberately, which
would change the LTV maths, so it was left alone rather than fudged.

**Privacy note surfaced in the UI, not just here:** a Custom Audience means sending
customer emails to a third party for advertising. The app deliberately does **not**
export contact lists — the counts are sizing only. Esses has 148 UK customers, so
lawful basis and privacy-policy disclosure want checking before a first upload.

### 4.11 🔴 FIXED — `revenue_class` had drifted into two more copies, both wrong

Found while wiring the boundary. The handoff previously recorded the comp
misclassification as "fixed… applied identically in order-profit.ts AND rollup.ts" —
which was true and **incomplete**. Two other copies of the CASE existed and neither had
the `customer_has_subscription` branch:

- `cogs.ts` (`COSTED_ORDERS`) → drove **`/international`**
- `profit.ts` (`getProductProfit`) → drove the per-product table on **`/profit`**

Both therefore labelled prepaid subscription deliveries as free comps, inflating the
comp programme and dropping those units out of trading margin entirely. Live for
several sessions on two pages.

**Fix: `order_profit` is now the single authority.** Both consumers JOIN it instead of
re-deriving, and the CASE exists in exactly one place. `getProductProfit` also stopped
re-deriving `origin` as a side effect.

The join is deliberately **INNER**: it makes the two populations identical, so
`/international` and `/profit` can never disagree about which orders exist — and they
now produce **identical CM2 to the cent** under every boundary, which they never did
before.

⚠️ **Correction to session 7's stated reason.** I originally attributed the 135-order
gap (and the 141 inflated comp units under a LEFT JOIN) to `cogs.ts` omitting
`processed_at IS NOT NULL`. That was **wrong**: verified in session 8, there are
**zero** countable orders with a NULL `processed_at`, so that filter excludes nothing.
The real cause was that `order_profit` was **stale** — last rebuilt before the
session-4 discount-code backfill added orders, so it held 7,995 rows against a
population of 8,130. The INNER JOIN is still correct (it guarantees the populations
match, which is the invariant worth having), but the failure it protects against is
**a stale `order_profit`**, not an unprocessed-order edge case. Run `run.cmd metrics`
after any backfill or `/international` silently under-reports.

⚠️ **Do not write another `revenue_class` CASE.** `REVENUE_CLASS_NOTE` in
`margin-boundary.ts` says so; four copies is how this happened.

### 4.12 ✅ Consolidated the rate-rule predicate (5 copies → 1)

`src/lib/shipping/rate-rules.ts` is now the single definition of how a shipment matches
a `shipping_rate_rules` row. `expectedRateCentsSql()` replaced hand-written subqueries
in `order-profit.ts`, `rollup.ts`, `cogs.ts` and **both** sites in
`lib/shipping/match.ts`. Zero copies of `rr.carrier_pattern IS NULL` remain outside it.

They had already drifted, which is the point:

- `order-profit.ts` and `rollup.ts` **ignored `service_pattern`** — a service-scoped
  rule would price differently on `/international` than in the materialised
  `order_profit` the Profit page reads
- both `match.ts` sites **ignored `zone`** — so the seeded "International (any
  carrier)" rule, scoped to `zone = 'row'`, could match a **US** shipment during batch
  allocation. `zoneFromCountrySql()` resolves zone from `market_config` for queries that
  have no zone column, which closes it.

**Behaviour-preserving where it matters, a real fix where it doesn't:** no rule
currently sets `service_pattern` (verified: 0 of 13), so the metrics path is unchanged.
**Two** rules set `zone`, so `match.ts` genuinely changes — for the better.

⚠️ **Dormant fix worth knowing about:** `exclude_country_code` is set on **0 of 13**
rules. The session-3 code change that scopes derived international rules to exclude US
only takes effect when `refreshRateRules()` runs, i.e. on a shipping-report sync or CSV
import — and ShopifyQL is still blocked (§6). The §5.1 shipping fix therefore currently
rests entirely on the country-population fix making the `country_code = 'US'` domestic
rules reachable at priority 60. That's sufficient today, but the belt-and-braces half is
not in the data yet.

### 4.5 Hardened Shopify network retry

A backfill died on a bare undici `fetch failed` after only ~5s of retry patience
(500ms × attempt). A backfill is ~170 sequential pages, so one blip lost the run. Now
exponential (1s→16s) and logged. The retry itself was pre-existing; only the ladder
changed.

---

## 5. ⚠️ OPEN PROBLEMS

### 5.1 ✅ RESOLVED — the margin boundary is now a live setting

No longer an open decision. Sam's call: treat it as an editable placeholder for
checking margins per region and product and adjusting live against goals, rather than
an accounting policy to settle up front. Built in session 7:

- `src/metrics/margin-boundary.ts` — pure types/labels/validator (**must stay
  dependency-free**, it's imported by a client component; see §6 gotcha)
- `src/metrics/margin-boundary.server.ts` — the SQL predicates + settings read
- `margin_settings.margin_boundary` column (migration `0008`), default `paid_only`
- Editable at **`/costs`** as radios showing each option's full trade-off
- `/profit` and `/international` both respect it and **display which boundary is
  active** with a link to change it
- Per-product (`getProductProfit`) and per-market (`getMarketMargins`) margins both
  respond, which is the "margins per region and product" ask

Safe to flip freely: **revenue is identical under all three** because comps and
prepaid deliveries collect $0, so the setting only re-filters which costs are
charged. Nothing is recomputed or rebuilt.

| Boundary | CM1 | CM2 | CM3 |
|---|---|---|---|
| Paid orders only *(default)* | $112,452 | **$84,703** (58.6%) | $55,179 (38.2%) |
| Paid + prepaid deliveries | $51,964 | **−$14,570** (−10.1%) | −$44,094 |
| Everything, incl. comps | $46,546 | **−$30,134** (−20.8%) | −$59,658 |

Verified end-to-end: setting each value and reading it back gives matching CM2 from
**both** `/profit` and `/international` (they agree to the cent for the first time —
see §4.11), and an invalid column value falls back to `paid_only` rather than throwing.

### 5.1a The underlying accounting question is still open (but no longer blocking)

The reason the three answers differ hasn't gone away: prepaid subscription deliveries
incur cost in a period whose revenue was recognised earlier. The *proper* fix is to
recognise subscription revenue ratably across the deliveries it funds, or report margin
per subscription cohort rather than per order. Worth doing eventually; the toggle means
nothing is blocked on it meanwhile.

Decomposition from `order_profit` (unchanged, and now reconciled everywhere):

| class | orders | units | COGS | shipping | net revenue |
|---|---|---|---|---|---|
| paid | 2,766 | 3,542 | $32,110 | $21,284 | $144,562 |
| prepaid_delivery | 4,712 | 5,958 | $60,488 | $35,265 | $0 |
| comp | 517 | 1,460 | $5,419 | $9,780 | $0 |

Prepaid subscription deliveries incur cost in one period while their revenue was
recognised in an earlier one. Three legitimate answers (refreshed, and now
**internally reconciled** — `cm2_from_components` equals stored `cm2_amount` exactly):

| Costs included | CM2 | % of net revenue |
|---|---|---|
| All classes | **−$30,134** | −20.8% |
| Excluding comps (**what `/profit` shows**) | **−$14,570** | −10.1% |
| Paid orders only (**what `/` and `/marketing` show**) | **+$84,703** | 58.6% |

Add Stripe's $7,466 (no cost attached) and the paid boundary gives the
**$92,169 / 60.6%** that `daily_metrics` reports.

Decomposition from `order_profit`:

| class | orders | units | COGS | shipping | net revenue |
|---|---|---|---|---|---|
| paid | 2,766 | 3,542 | $32,110 | $21,284 | $144,562 |
| prepaid_delivery | 4,712 | 5,958 | $60,488 | $35,265 | $0 |
| comp | 517 | 1,460 | $5,419 | $9,780 | $0 |

⚠️ **The previous handoff's §5.2 figures (−$55,761 / +$37,127 / +$90,117) did not
reconcile with their own decomposition table** — "excluding comps" cannot be +$37,127
when prepaid alone carried $142K of cost against $0 revenue. Don't use them as a
baseline. The numbers above are recomputed from components and check out.

**Proper fix (not built):** recognise subscription revenue ratably across the
deliveries it funds, or report margin per subscription cohort rather than per order.
Until then two pages disagree by design, which is confusing for a business user —
worth resolving as a product decision, not silently.

### 5.2 🔴 Meta access is blocked at the APP level — a new token will NOT fix it

Diagnosed properly in session 6. **Do not spend time generating a fresh token until
the app itself is unblocked** — it will fail identically.

Evidence (differential test against the same endpoint):

| token | HTTP | code | message |
|---|---|---|---|
| **ours** | 400 | **200** | `API access blocked.` |
| obvious garbage | 400 | 190 | `Invalid OAuth access token - Cannot parse` |
| well-formed fake | 400 | 190 | `Malformed access token` |
| ours, truncated | 400 | 190 | `The access token could not be decrypted` |

Meta **recognises and decrypts our token fine** — a bad token returns code 190, ours
returns code **200**, which is the permissions/app family. Decisively, `/debug_token`
also fails, and that endpoint normally answers even for *expired* tokens. Every
endpoint fails identically (`/me`, `/debug_token`, `/me/permissions`, the ad account,
`/me/accounts`), so it isn't scope-specific either.

**Conclusion: the app or its Business account is restricted, not the credential.**
Typical causes, in likelihood order: an overdue **Data Use Checkup**, lapsed
**Business Verification**, the app flagged/disabled by a policy review, or the app in
Development mode with the token's user no longer an admin/tester.

**Fix path (all in Meta's UI, none of it in code):**
1. `developers.facebook.com/apps` → open the app → read the alert banner at the top.
2. Check **App Review → Permissions and Features** for anything reverted to Standard
   Access, and **Settings → Advanced** for a Data Use Checkup prompt.
3. Check `business.facebook.com` → **Business Settings → Security Centre** for
   Business Verification status.
4. Resolve whatever is flagged, then generate the token and paste it into `.env`.

Then: `run.cmd check:ads`, `run.cmd backfill --since=2025-10-01 --source=ads`,
`run.cmd metrics`. The `claimExceedsAllOrders` guard clears itself once the data is
sane.

Meanwhile spend, impressions and clicks are unaffected (they predate the §4.3 bug and
the block), so **MER, aMER, CAC and CM3 remain trustworthy**.

### 5.2a Scopes needed once the app is unblocked

Currently granted: `read_all_orders, read_customers, read_fulfillments, read_orders,
read_products` on Shopify; on Meta the ads read worked, so `ads_read` is present.

For the **engagement half of `/social`** (§4.8) add, on a Meta token tied to a
Business/Creator Instagram account linked to a Facebook Page:

| Permission | What it unlocks |
|---|---|
| `instagram_basic` | account identity, media list, media type/format |
| `instagram_manage_insights` | impressions, reach, profile visits, follower count, per-post and per-story insights |
| `pages_show_list` | discovering the Page the IG account is linked to |
| `pages_read_engagement` | Page-level engagement needed alongside IG insights |
| `read_insights` | Page/account insight time series |
| `ads_read` | (already working) campaign spend/delivery |

⚠️ `instagram_manage_insights` needs **App Review** for Advanced Access before it
works on an account you don't own — budget time for that, it isn't instant. Story
insights expire after 24h, so stories must be polled daily or they're lost forever;
that's a scheduling requirement, not a code one.

### 5.2b Not yet built: the Instagram connector

Deliberately **not** written this session. The handoff already records the EasyShip
lesson — "API path written from docs only, needs a token and `healthCheck()` before
trusting field names" — and writing a second unverifiable connector against a blocked
API would repeat it. The moment the app is unblocked, build it token-first: probe
`/me/accounts` → IG business account id → `/{ig-id}/insights` and confirm the metric
names before mapping anything.

### 5.3a ✅ Built — COGS coverage + sensitivity (`src/metrics/cogs-scenario.ts`)

Sam's ask: make COGS a variable setting, since it changes per magazine and as
logistics/packing improve. **The data model already supported that** —
`product_costs` is keyed `(sku, origin, effective_date)` and `/costs` accepts both
real SKUs and synthetic `variant:<uuid>` keys — so nothing new was needed to *vary*
cost. What was missing was knowing what a change is worth, and being able to model it
before committing. Both now on `/costs`:

- `getCogsSensitivity()` — CM1/CM2/CM3 at a range of per-unit costs, holding shipping,
  packaging, processing and ad spend exactly as recorded
- `breakevenCogsPerUnitCents()` — the per-unit cost where CM3 hits zero. Pure and
  tested; **can legitimately return a negative number**, meaning other costs already
  exceed revenue and no print price would help. Reported honestly rather than clamped.
- `getCogsCoverage()` / `getCogsCoverageSummary()` — which products carry a cost, and
  units exposed, ordered so the list is a work queue

Scenarios are **ephemeral by design** — they never write to `product_costs`.
Committing a real cost stays the effective-dated edit, so a what-if can't quietly
become the recorded truth.

**🔴 The finding that matters most, and it changes the COGS question entirely.**
Breakeven per copy swings enormously with the margin boundary:

| Boundary | units | breakeven / copy | effective today |
|---|---|---|---|
| Paid orders only | 3,542 | **$24.64** | $9.07 |
| Paid + prepaid deliveries | 9,500 | **$5.11** | $9.75 |
| Everything, incl. comps | 10,960 | **$3.50** | $8.94 |

So: counting only paid orders, Esses could afford $24.64 a copy and the $11.48
placeholder is comfortable. Counting the deliveries those subscriptions actually fund,
**the ceiling is $5.11 and we're paying about $9.75** — the older ~$5.50 figure is
roughly breakeven and $11.48 is far underwater. **The print-cost question is only
alarming at the honest boundary**, which is exactly why §5.1's toggle and this table
belong together.

⚠️ **And the effective cost is currently UNDERSTATED, which flatters everything.**
Coverage is **77.9%**: 2,422 of 10,960 units have no cost record, so they're costed at
**$0** and drag the blended rate down to $9.07 rather than $11.48. Margin everywhere in
this app is optimistic by roughly the value of those units. Setting them will make the
numbers worse and more correct. Biggest exposures: Issue 03 (Pre-order) **790 units**,
Issue 05 Contributor Copy 270, Navy Corduroy Cap 208, Issue 06 Contributor Copy 171,
Square Guide to Austin 147.

⚠️ **COGS does not actually vary yet:** `distinctCostValues` is **1**. Only 6 SKUs are
costed (ME2–ME5, SUB, Subscription), all at $11.48, and only **5 of 76 products** are
fully covered. Per-issue costing is structurally available and practically empty —
Issue 01 and 06 have zero costed SKUs, Issue 03 has 1 of 7. Also note the SKU→issue
mapping is not clean (`ME4`'s dominant title is "Esses Issue 05"), so per-issue COGS
should be set against the specific cost keys in the work queue, not assumed from SKU
names.

### 5.3 The COGS placeholder dominates everything — **still needs Sam**

`$11.48/issue` is an unverified placeholder from the May 2026 international sheet.
Older calculators said **~$5.50**. At ~10,960 units that's ~$126K vs $152K revenue —
**this single number decides whether the all-in picture is positive or negative.**
UI to enter it (and the UK printer-park per-copy cost) already exists at `/costs`.
745 units still have no cost record at all, so their COGS counts as $0.

### 5.4 Attribution vs blended still disagree — but the story is now sharper

| | Blended | Attributed (paid-meta) |
|---|---|---|
| Return | **MER 5.15** | **ROAS 0.15 – 0.61** (band) |
| CAC | **$7.99** | **$163.12 or better** |

Coverage is 40.7% of all revenue / 56.4% of addressable, and **Esses doesn't UTM-tag
links**, so paid Meta traffic without an `fbclid` is classified `organic-social`
(1,049 orders / $13,409 sit in that ambiguous pool).

**Trust MER directionally** (it needs no attribution). **Attributed ROAS currently
measures our coverage, not Meta's performance.** UTM tagging
(`?utm_source=meta&utm_medium=paid_social`) collapses the band to a single number and
remains the highest-value action available to Sam. The `/marketing` page says all of
this on the page itself.

Note the four attribution models agree closely on paid-meta (ROAS 0.15–0.16), so model
choice is *not* the source of uncertainty here — coverage is.

### 5.5 🔴 Over half the subscriber base has NEVER faced a renewal

The most important churn finding, and it reframes the retention story:

**1,981 of 3,468 subscriptions have not reached their first rebill.** The
"Annual Payment, Quarterly Delivery" plan (1,766 subs) bills every **12 months**, and
the data only starts 2025-10 — so not one annual subscriber has made a renewal
decision yet. All Stripe plans are likewise too young.

Consequences:

- The previously-reported **"retention cliff 82% (m3) → 61% (m4)"** is entirely the
  **Quarterly** plan. For an annual subscriber, month 4 is not a renewal at all — the
  blended month-by-month survival curve on `/customers` mixes two different decision
  schedules and should be read with that in mind.
- Measured properly per cadence, the Quarterly plan loses **43.7% at the first rebill**
  (n=1,068 mature) and 18.5% at the second. That's a worse first-renewal cliff than the
  old blended number implied.
- **Annual renewal behaviour is simply unknown and first becomes measurable ~Oct 2026.**
  It carries the larger revenue per renewal. This is the single biggest open question
  about retention, and no amount of current data answers it.

### 5.6 Churn findings worth acting on (all maturity-corrected)

- **Discounting does NOT appear to attract worse subscribers** — the opposite. The "no
  promo code" cohort churns **45.9%** by first renewal, while `freeship75` is 21.3%
  (n=47 mature), `BLACKFRIDAY50` 20.0% (n=20) and `SUBSCRIBE25` 0% (n=14). Small
  denominators on several, so treat as a strong lead rather than settled — but the
  intuitive "discount hunters churn" hypothesis is not supported here.
- **Channel quality varies enormously.** `organic-social` — our biggest attributed
  channel — churns **51.1%** by first renewal at **$27.28** LTV/sub. `newsletter` is
  ~0% at **$113.19** (n=8 mature, thin but consistent with the §5.4 LTV finding).
  `direct` 27.1% / $58.78. `paid-meta` 48.4% / $46.39.
- **Issue 04 signups retain far better than Issue 05:** 15.0% vs **49.4%** churn by
  first renewal, and $93.81 vs $32.71 LTV/sub. ⚠️ Confound to check before acting:
  plan mix may differ between those windows, and cadence drives the renewal point. Use
  `getChurnCohorts` with a plan filter to separate the two effects.
- `Y53B75GYRYQ7` looks great on raw churn (11.0%) and poor on the comparable metric
  (47.1%) — a clean demonstration of why the maturity-corrected column exists.

### 5.7 Smaller things found, not fixed

- **18 prepaid orders carry $42–$575 shipping** on `actual` (invoice) basis, 911 units
  between them. Probably legitimate multi-copy batch shipments, but unverified.
- **15 destination countries aren't in `market_config`** (BE 12, IE 4, KR 4, AT 3, PT,
  CZ, CN, AD, TW, EE, HR, HU, IN, MC, SA). They fall back to `row` zone / 0% VAT, so
  their margin is optimistic. `/international` flags them as "unmapped".
- **85 orders still have no country** → they match `exclude_country_code` rules and get
  international rates (73 of them at $14.44/unit). Small, but they're the reason the
  `COALESCE(om.country, '')` guard exists in the matching SQL.
- ~~**Rate-rule matching SQL is copy-pasted in four places.**~~ ✅ Done in session 8 —
  see §4.12. Both this and the `revenue_class` CASE (§4.11) now have exactly one
  definition, alongside `OPS_DISCOUNT_SQL_REGEX` in churn.ts. **Three duplications, two
  of which had already caused live bugs.** If you add a fifth surface that needs any of
  them, import the shared fragment.
- **Issue release windows are derived, not authoritative.** `getIssueWindows()` infers
  them from first non-pre-order sale. Issues 01–03 were already selling when the data
  window opened, so they're collapsed into an honest "Issue 03 or earlier" cohort.
  Supplying real on-sale dates would make `issue_at_signup` exact — a small table would
  replace the derivation, and nothing else in the module needs to change.
- **270 Skio subscriptions have a NULL status** while clearly live (they hold a
  `next_billing_at`). `churn.ts` keys off `cancelled_at` first and status second for
  exactly this reason; anything new reading `subscription_meta.status` directly should
  do the same. 7 canceled subs have no cancellation date and are excluded from timing
  maths (reported as `churnedWithoutDate`).

---

## 6. Everything tried that FAILED (don't repeat these)

### Shopify auth
- ❌ **Legacy custom-app static token** — retired on this store ("Spring '26" UI).
- ❌ **Looking for a copyable token in the Dev Dashboard** — there isn't one.
- ✅ **Client-credentials grant.** `POST https://{shop}/admin/oauth/access_token` with
  `grant_type=client_credentials&client_id=&client_secret=` → `shpat_…` valid **24h**.
  Implemented in `src/connectors/shopify/auth.ts` (caches, refreshes 5 min early,
  retries once on 401).
- ⚠️ **`SHOPIFY_SHOP` must be the myshopifyDomain** = `9fee88-ec.myshopify.com`,
  **NOT** `essesmag.myshopify.com`. The token endpoint rejects the primary domain.
- Current token scopes: `read_all_orders, read_customers, read_fulfillments,
  read_orders, read_products`.

### Shopify shipping label costs
- ❌ **`Fulfillment` object has no cost field.** Verified via introspection.
- ❌ `order.shippingLine` — that's what the *customer was charged*, not our cost.
- ✅ **ShopifyQL `shipping_labels` dataset** via `shopifyqlQuery`. Verified live.
- ⚠️ **Still blocked:** needs **`read_reports`** AND **Level 2 protected customer data
  access**. Confirmed again this session — the sync logs a warning, marks the run
  `partial`, and falls back to estimates, by design.
- ⚠️ **Don't over-generalise that block.** Order `shippingAddress.countryCodeV2` reads
  fine on the same token; only ShopifyQL is gated. Assuming otherwise is what let §4.1
  hide for two sessions.

### Meta ads
- ❌ **One request for the whole 10-month window** → `HTTP 400 code 2`. It's a
  size/rate problem, not an outage.
- ✅ **Monthly chunking + 3s between chunks + 750ms between pages + 7 attempts with
  backoff to 120s.** Result: 6,195 rows, 18 pages, all ten months.
- ⚠️ I twice declared this "failed" by checking `sync_runs` **mid-run**. Wait for the
  background task notification before judging.
- ❌ **Summing Meta's purchase action types** — see §4.3. They overlap.
- ⚠️ Token now returns "API access blocked" (§5.2).

### Skio
- ❌ **Raw / `Bearer` token** — returns HTTP 200 but silently resolves to the `unauth`
  role where `Subscriptions` doesn't exist. A *wrong-answer* failure, not an auth error.
- ✅ **`Authorization: API <key>`** (the "API " prefix is required).
- ❌ **`Subscription.Orders` and `Order.subscriptionId` are both EMPTY** on this
  account. Link by **(customer + Shopify selling-plan GID)** against
  `order_line_items.selling_plan_id`. Only 2 plans: `6773899551` "Quarterly
  Subscription", `6592004383` "Annual Payment, Quarterly Delivery".
- ⚠️ **MRR follows the DELIVERY cadence, not billing.** "Annual Payment, Quarterly
  Delivery" bills MONTH×12 at $25/delivery = **$8.33/mo**, not $25/12.

### Analytics correctness bugs found by validating against live data
- ❌ **Ingest mapping a field the GraphQL query never requested** — silent NULLs, no
  error anywhere. Hit twice in one query (country, presentment). **When a column is
  unexpectedly all-NULL, check the query before checking permissions.**
- ❌ **AOV divided by all orders** → $18.57. **65% of orders are $0**. True AOV over
  paid orders is **$53.15**. Pinned by `tests/aov.test.ts`.
- ❌ **`returning_customers` as distinct-per-day** — not additive. Now stores **repeat
  orders**.
- ❌ **Self-referral as a channel.** `www.essesmag.com` made "referral" the biggest
  channel at $34K. Added `internal` channel + `isOwnDomain()`.
- ❌ **Then `internal` itself became the top channel at $33K.** Internal-only paths are
  now **unattributed** rather than credited to a pseudo-channel.
- ❌ **`stampAcquisitionChannels` stamped `internal`** for 640 customers → $33.6K
  phantom channel. Excluded in SQL + guarded again at inheritance.
- ❌ **Comp misclassification.** "$0 and not subscription-linked = comp" labelled ~2,400
  units of **prepaid subscription deliveries** as giveaways. Fixed with
  `customer_has_subscription`.
- ❌ **Dividing by all orders to get AOV — reintroduced in session 5 and caught again.**
  `getSocialPlatformPerformance` first reported Instagram AOV as **$13.59** because 65%
  of orders are $0. Correct figure over paid orders: **$45.27**. This trap has now bitten
  twice; **any new per-order average must divide by `total_amount > 0`.** The same fix
  applies to campaign rows, where `attributedOrders` vs `attributedPaidOrders` separates
  "sold 25 magazines" from "gave away 25 subscriptions".
- ❌ **Believing `fbclid` reaches us.** The old note here claimed fbclid-tagged clicks
  existed and drove paid detection. They don't: **`click_id` is 0 across all 4,400
  touchpoints**, because Shopify's `customerJourneySummary.landingPage` **strips the
  entire query string** — 0 of 4,400 landing URLs contain a `?`. So `parseClickId()` and
  the landing-page branch of `parseUtms()` can never fire in practice; the ONLY UTM
  source is Shopify's own parsed `utmParameters` field. This makes the tagging rollout
  the sole route to paid-click identification, not merely an improvement.
- ❌ **"UTMs are null everywhere."** Also outdated. **Meta is already auto-tagging**:
  471 touchpoints carry a `utm_medium` and 387 a `utm_campaign`. But it sends the
  campaign **ID** (`120231993199500507`), not the name, and sometimes puts the ADSET
  NAME in `utm_medium` — which is why some genuinely paid campaigns classify as
  `organic-social`. The `{{campaign.name}}` line in the tagging guide fixes this.
- ❌ **Cohort LTV read as collapsing** ($88 → $37) — an artifact of observation window.
  **LTV @ 3mo** shows $31.69 → $72.48 → $72.29 → $75.66: improving, not falling.
- ❌ **One source failing aborted the whole sync.** `scripts/sync.ts` now isolates each
  source and sets a non-zero exit at the end.
- ❌ **Trusting a platform's conversion count without a reality check.** A platform
  cannot drive more purchases than the store received; that one comparison exposed a
  3× ingest bug instantly. The `claimExceedsAllOrders` guard now runs it permanently.

### Tooling gotchas
- ❌ postgres.js **cannot bind a JS `Date`** through raw `db.execute(sql\`\`)`. Use
  `now()` in SQL.
- ❌ `uniqueIndex(...).nullsNotDistinct()` doesn't exist in this Drizzle version — use
  `unique(name).on(...).nullsNotDistinct()`.
- ❌ **Drizzle's `sql\`\`` expands a JS array as a parenthesised tuple `($3,$4,$5)`,
  not a Postgres array** — so `col ILIKE ANY(${arr})` fails with *"op ANY/ALL (array)
  requires array on right side"*. Use a single `~*` regex, or build an OR chain.
- ❌ **`round(x, 2)` fails on `double precision`** (`function round(double precision,
  integer) does not exist`). Cast: `round(x::numeric, 2)`.
- ❌ **`pnpm start -- -p 3011` passes `--` through literally** to `next start`, which
  reads it as a project directory. Use `$env:PORT="3011"` instead.
- ❌ **Importing a module with a DB dependency into a `"use client"` file** kills the
  build: `Module not found: Can't resolve 'fs'`, traced through
  `postgres/src/index.js → src/db/client.ts → your module → [Client Component Browser]`.
  Hit when the `/costs` settings form imported `margin-boundary.ts`. Fix is the split
  now in place: pure constants/types in `margin-boundary.ts`, drizzle + db in
  `margin-boundary.server.ts`. **Any shared module a client component imports must be
  dependency-free.** Typecheck passes either way — only `build` catches it.
- ❌ **Escaped backticks inside a drizzle `sql\`\`` template** are a TS parse error
  (`TS1005: ',' expected`). Use double quotes in SQL comments, not backticks.
- ❌ **Markdown TABLES convert badly when creating a Google Doc** via the Drive
  connector: bold + underscores inside cells came through as literal `\*\*Where\*\*` and
  `utm\\\_source`. Body text, headings, bullets, block quotes and bold all convert
  fine. Use labelled lists instead of tables. Also note the connector is
  **create/read only** — no update or delete — so a bad doc can't be fixed in place,
  and `fileSize: "1"` in the response is normal for a converted Doc, not a failure.
  Always read the doc back to verify before sharing it.
- ❌ PowerShell heredocs (`<<'PY'`) are a parser error. Use the Bash tool or `Write`.
- ❌ Redirecting a native command's stderr in PowerShell (`2>&1`) wraps output in
  ErrorRecords and reports failure on exit 0. Don't.
- ⚠️ Sam's first Notepad save of `.env` **silently didn't persist**. Always verify
  `LastWriteTime` + key lengths after asking him to edit a file.

---

## 7. Next step I would take

**In order:**

1. **Separate the plan-mix confound in the issue cohorts (§5.6).** Issue 04 vs Issue 05
   retention differs by 34pp, which would be a major editorial/marketing signal — but
   cadence drives the renewal point, so confirm it survives a per-plan split before
   anyone acts on it. Cheap: `getChurnCohorts('issue_at_signup')` plus a plan filter.

4. **Forecast/Goals page** (phase 9) — the last major missing dashboard from the brief.

**Blocked on Sam (don't guess these):**
- Real per-copy **COGS** + **UK printer-park** cost → §5.3 (now the single biggest
  unknown, since the margin boundary is settled)
- **Archive.com** API credentials — Sam is starting that integration himself. The social
  doc's EMV / potential-reach / UGC metrics come from `app.archive.com`, a separate
  social-listening tool with its own API. Nothing in this repo touches it yet; when it
  lands it should follow the same connector contract (`backfill` / `incrementalSync` /
  `healthCheck`) and be verified token-first like every other connector.
- A working **`META_ACCESS_TOKEN`** → §5.2, unblocks conversion reconciliation
- **`read_reports` + Level 2** customer data access → auto shipping cost sync
- **UTM tagging rollout** → collapses the §5.4 band. Guide is written and delivered
  (§4.7); it now needs the social manager to actually apply it, plus the one-time Meta
  Ads Manager URL-parameters setup.
- **Real issue on-sale dates** → makes `issue_at_signup` exact instead of derived (§5.7)
- Delete the superseded UTM doc in Drive (§4.7) — connector can't

**Deliberately deferred:** AI insights + Slack digest (phase 9), validation pass
(phase 10), advertiser delivery reporting (phase 11), durable hosting + DNS.

**Housekeeping:** the Stripe and Skio keys passed through chat and should be rotated.
Git now has a baseline commit (§4.9) — subsequent work is diffable and revertable, and
there's still no remote, so nothing has left the machine. Set a global git identity when
convenient.

**Next connector worth building:** Instagram Graph API for the engagement half of
`/social` (§4.8) — follower growth, reach, per-post metrics. Needs a Meta token with
`instagram_basic` + `pages_read_engagement` against a Business/Creator account linked to
a Facebook Page. Blocked on the same dead `META_ACCESS_TOKEN` as §5.2, so refreshing
that token unblocks two things at once.

---

## 8. Verification stamp

Re-run these first to confirm nothing drifted:

```bash
C:\Users\samwi\esses-analytics\run.cmd test        # expect: 17 files, 189 tests pass
C:\Users\samwi\esses-analytics\run.cmd exec tsc --noEmit   # expect: silent
C:\Users\samwi\esses-analytics\run.cmd build      # expect: 13 routes, clean
C:\Users\samwi\esses-analytics\run.cmd metrics    # expect: 304 days, MER 5.15
```

⚠️ `tsc --noEmit` does **not** catch a client component importing a DB-dependent
module — only `build` does (§6). Run build before trusting a change that touches
shared modules.

Verified passing at handoff time (2026-08-04, session 7): **189/189 tests**, typecheck
silent, build clean (13 routes), all pages rendering 200 against live data —
`/marketing` under every model/basis combination, `/churn` under every one of the six
cohort dimensions, `/social`, `/personas`, and `/costs` with the boundary form. The
boundary was set to each of its three values and read back, with `/profit` and
`/international` agreeing to the cent each time.

Headline numbers as of handoff — quote these with their caveats, not bare:
- Revenue (net, Shopify paid ex-VAT + Stripe): **$152,204**
- Ad spend: **$29,524** · **MER 5.16** · **aMER 2.54** · blended CAC **$7.72**
- CM1 **$119,918** / CM2 **$92,169** / CM3 **$62,645 (41.2%)** — from `daily_metrics`,
  which includes Stripe's $7,466 and is always on the paid-order boundary because that
  matches MER's revenue base. `/profit` and `/international` show **$84,703** on the
  same boundary (Shopify only) and both follow the live setting — §5.1
- Breakeven MER **1.65×** at 60.6% CM2 margin — advertising covers itself on blended
- Attributed paid-meta ROAS **0.15×–0.61×** (band, not a point estimate) — §5.4
- Blended LTV **$66.58**; subscriber premium only **1.1×**
- Quarterly plan loses **43.7% at the first rebill** (n=1,068 mature) — measured per
  cadence. The old blended "82% → 61% at m3–m4" conflated two billing schedules; see §5.5
- **1,981 of 3,468 subscriptions have never faced a renewal** — annual plan untested
  until ~Oct 2026 (§5.5). Don't present a base-wide renewal rate
- Best channel by LTV: **newsletter $105.41** vs **paid-meta $50.76**; by retention,
  newsletter ~0% vs organic-social **51.1%** churn at first renewal (§5.6)
- ⚠️ Meta's *self-reported* conversions are stale and ~3× inflated — §5.2

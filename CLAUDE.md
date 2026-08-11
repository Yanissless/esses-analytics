# Working in this repo

Internal analytics for Esses Media (F1/motorsport magazine, subscription e-commerce) —
an owned replacement for StoreHero. Next.js 16 · TypeScript · Drizzle + Postgres · Vitest.

**New session? Read `START-HERE.md` first.** Deep history, every failed approach and all
open problems are in `HANDOFF.md`. Going live is `DEPLOY.md`.

---

## Commands

Node and pnpm were installed after this machine's shells were created, so `pnpm` may not
be on PATH. **Always use the launcher:**

```powershell
.\run.cmd test          # 218 tests
.\run.cmd exec tsc --noEmit
.\run.cmd lint          # expect 0 errors (6 unused-import warnings are pre-existing)
.\run.cmd build         # 17 routes
.\run.cmd check:deploy  # preflight: config, DB, data, connectors — start here when anything looks wrong
.\run.cmd metrics       # rebuild order_profit + daily_metrics
.\run.cmd sync          # incremental all sources
.\run.cmd backfill --since=2025-10-01 --source=shopify|skio|stripe|ads
```

This is **Windows PowerShell**. There is no inline env-var prefix — `FOO=bar cmd` fails.
Use `$env:FOO = "bar"` on its own line. Scripts run via `tsx` need **relative** imports
(`@/*` is Next-only).

**On macOS/Linux, read every `.\run.cmd x` as `./run.sh x`** — same scripts, POSIX
launcher — and `$env:FOO = "bar"` as `export FOO="bar"`. `DEPLOY.md` has a Mac section.

---

## Hard rules

These each exist because breaking them already caused a live bug. Comments in the code
point back here.

1. **Never write another `revenue_class` CASE.** It's derived in exactly one place,
   `metrics/order-profit.ts`. It once existed in four, and two copies silently lacked the
   `customer_has_subscription` branch — so `/international` and the per-product table
   classified prepaid subscription deliveries as free comps for several sessions. **JOIN
   `order_profit`** to read it.

2. **Never duplicate the shipping rate-rule predicate.** One definition in
   `lib/shipping/rate-rules.ts`. Five copies had already drifted: two ignored
   `service_pattern`, two ignored `zone`.

3. **Ratios return `null`, never 0 or Infinity, when the denominator is 0.** Zero reads
   as "terrible performance"; null renders as "—" and means "not measurable". `cac()`
   returns null at zero spend deliberately.

4. **Any per-order average divides by orders with `total_amount > 0`.** 65% of this
   store's orders are $0 (prepaid subscription deliveries and comps). This has bitten
   twice — AOV read $18.57 instead of $53, and Instagram AOV $13.59 instead of $45.27.

5. **Run `.\run.cmd metrics` after any backfill.** `order_profit` and `daily_metrics` are
   materialised; a stale rebuild makes `/international` silently under-report.

6. **A module imported by a `"use client"` file must be dependency-free.** Importing the
   DB client into the client bundle fails the build with `Can't resolve 'fs'`. Pattern in
   use: pure values in `x.ts`, drizzle/db in `x.server.ts` (see `margin-boundary.ts`,
   `forecast.ts`). **`tsc` does not catch this — only `build` does.** Decide the split
   when you create a shared module, not after the build breaks.

7. **Guard pages with `requireCapability(cap)`, never a role comparison.**
   `lib/auth/capabilities.ts` is the single definition of who sees what. A missed page
   leaks financial or customer data rather than merely miscalculating.

8. **Never quote a margin figure without naming the boundary.** Which revenue classes
   bear cost is a live setting (`/costs`); the same period legitimately reads +$85K,
   −$15K or −$30K. `/profit` and `/international` display which one is active.

---

## Data model essentials

Three revenue sources that must never be double-counted:

- **Shopify** — the single source of truth for ALL order revenue, one-time *and* Skio
  subscription orders.
- **Skio** — enrichment ONLY (plan, status, churn, MRR). Never a second source of order
  revenue.
- **Stripe** — a separate, additive stream (print/digital subscriptions).

Three revenue classes, never blended:

- `paid` — money collected.
- `prepaid_delivery` — a $0 shipment against a subscription paid for earlier. A timing
  offset, not a giveaway.
- `comp` — a genuinely free copy (contributor/VIP/event). Real cost, no revenue ever.

⚠️ **Skio MRR follows the DELIVERY cadence; churn follows the BILLING cadence.** Same two
fields, opposite choice, on purpose — "Annual Payment, Quarterly Delivery" bills every 12
months but delivers every 3.

---

## Verifying work

Run all four: `test`, `tsc --noEmit`, `lint`, `build`. They catch different things —
`tsc` misses the client/server import problem, `lint` catches impure calls during render
that neither of the others do.

For anything touching money, **also check the numbers moved the way you predicted** and
reconcile against a second surface. Several bugs here passed every test.

---

## Blocked, don't retry

- **Meta API** — a **Meta enforcement action** on the app or business. **Nothing to fix in
  code, and nothing to rebuild.** The token is `Valid: True` per Meta's own debugger —
  System User, non-expiring, `ads_read` + `read_insights`, app `28698775013059115`. Ruled
  out and not worth re-testing: a new token (identical failure), and an API version sunset
  (identical `code=200` on v20.0–v26.0). **Run `run.cmd check:meta`** — it separates token /
  app / scope causes and prints the ordered remediation. Detail in `HANDOFF.md` §5.2.
- **ShopifyQL `shipping_labels`** — needs `read_reports` *and* Level 2 protected customer
  data access. Non-fatal by design; shipping falls back to rate rules.

---

## Style

Match the surrounding code. Comments explain **why**, especially where a subtle choice
would otherwise look like a mistake — that's the house style and most non-obvious
decisions here already carry one. Don't add narration for its own sake.

# Esses Analytics

> **Picking this up for the first time? Read [`START-HERE.md`](./START-HERE.md).**
> Going live is [`DEPLOY.md`](./DEPLOY.md) · conventions and hard rules are in
> [`CLAUDE.md`](./CLAUDE.md) · the full history, every failed approach and every open
> problem is in [`HANDOFF.md`](./HANDOFF.md).
>
> First two commands: `.\run.cmd install` then `.\run.cmd check:deploy`.

Internal sales, marketing, and customer-value analytics for **Esses Media / Esses
Magazine Shop** — a StoreHero replacement we own and can extend. Unifies customer
LTV across **Shopify** (one-time + Skio subscription orders) and **Stripe** (print
+ digital subscriptions), layers on profit-first marketing metrics (MER / aMER /
CAC / contribution margin), multi-touch attribution, forecasting, and an AI
insights feed.

> Internal admin tool. Deployed to a hidden `esses.com` subdomain behind an auth
> wall — never linked from or discoverable via the public site.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS**
- **Postgres** via **Drizzle ORM** (SQL-first — the workload is aggregation-heavy)
- **jose**-signed session cookies + **bcryptjs** for a lightweight, self-owned auth
- **Vitest** for tests (metric formulas + dedup logic are the priority targets)
- Package manager: **pnpm**

## Project structure

```
src/
  app/            # dashboard UI + API routes (App Router)
  db/             # drizzle schema, client, migrations helper
  lib/            # env validation, logger, auth, shared utils
  connectors/     # one module per source (generic Connector contract)
  metrics/        # formula engine (MER/aMER/CAC/CM/LTV) — later phase
scripts/          # backfill / sync / seed entrypoints
drizzle/          # generated SQL migrations
tests/            # vitest specs
```

## Local setup

Prerequisites: **Node 20+**, **pnpm**, and a **Postgres** instance.

```bash
pnpm install
cp .env.example .env          # then fill in DATABASE_URL and AUTH_SECRET
pnpm db:generate              # generate SQL migration from the schema
pnpm db:migrate               # apply migrations
pnpm db:seed                  # create the initial admin users
pnpm dev                      # http://localhost:3000
```

Generate an `AUTH_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Run the app in development |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:seed` | Seed admin users |
| `pnpm db:studio` | Open Drizzle Studio (DB browser) |

## Build phases

1. **Foundation** — scaffold, schema, config/secrets, auth/roles ← _current_
2. Shopify + Stripe connectors (revenue sources of truth)
3. Skio connector (subscription enrichment; dedup against Shopify orders)
4. COGS system (product costs + admin UI + CSV import)
5. Ad platform connector (Meta first)
6. Metrics engine (`daily_metrics` rollup)
7. Attribution engine
8. Dashboard UI + hosting/access
9. AI insights + Slack digest
10. Validation pass
11. Newsletter + on-site placements + advertiser delivery reporting

Each phase ends with a built / verified / assumed summary before the next begins.

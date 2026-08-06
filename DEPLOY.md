# Deploying Esses Analytics

Getting a live instance the team can review. Written to be followed in order.

Nothing here needs a code change — the app is deployment-ready. What it needs is a
database, a host, DNS, and the secrets pasted into the host's environment.

---

## What you're standing up

| Piece | Choice | Why |
|---|---|---|
| Host | **Vercel** | It's a Next.js app; zero config, and `vercel.json` already declares the nightly cron. |
| Database | **Neon** or **Supabase** Postgres | Managed, has a connection pooler, generous free tier. The app is plain Postgres 17 — no extensions. |
| DNS | a hidden subdomain of `esses.com` | e.g. `analytics.esses.com`. Not linked from anywhere public. |
| Auth | already built in | Nothing to buy. Every route is behind a session wall, deny-by-default. |

---

## 1. Create the database

Create a Postgres instance and copy its **pooled** connection string. On Neon that's the
one with `-pooler` in the host; on Supabase it's the connection-pooling URI.

> **Use the pooled string.** Serverless functions open a connection per invocation, and a
> direct connection will exhaust the database's connection limit under any real use.

Then create the schema and the first admin, from your machine:

```bash
DATABASE_URL="<pooled-url>" run.cmd db:migrate
DATABASE_URL="<pooled-url>" SEED_ADMIN_PASSWORD="<something-long>" run.cmd db:seed
```

That gives you one working login. Everyone else is added through the **Team** page — no
CLI needed after this.

---

## 2. Load the data

**Run the backfill from your machine, pointed at the production database.** Not from the
deployed app.

```bash
DATABASE_URL="<pooled-url>" run.cmd backfill --since=2025-10-01 --source=shopify
DATABASE_URL="<pooled-url>" run.cmd backfill --since=2025-10-01 --source=skio
DATABASE_URL="<pooled-url>" run.cmd backfill --since=2025-10-01 --source=stripe
DATABASE_URL="<pooled-url>" run.cmd metrics
```

Why not from the app: a Shopify backfill walks ~170 sequential pages and takes about ten
minutes, which exceeds the function timeout on every hosting plan worth using. Backfills
are a deliberate operator action; only the **incremental** sync is automated.

Skip `--source=ads` until the Meta app block is resolved (see `HANDOFF.md` §5.2).

> Alternatively `pg_dump` your local database and restore it — faster, and it carries the
> shipping-label costs that can't currently be re-synced because ShopifyQL is blocked.
> If you do that, still run `db:migrate` first so the schema matches.

---

## 3. Deploy

Point Vercel at the repo (it needs a remote — see §6) and set these environment
variables in the project settings. **Paste them in the Vercel UI, not into a file.**

**Required**

- `DATABASE_URL` — the pooled string from step 1
- `AUTH_SECRET` — `openssl rand -base64 48`. Signs session cookies; changing it signs
  everyone out.
- `CRON_SECRET` — `openssl rand -base64 48`. Guards `/api/sync`. **Without it the sync
  endpoint refuses every request**, so the app deploys fine but data goes stale.
- `APP_BASE_URL` — `https://analytics.esses.com`

**Connectors** — copy from your local `.env`:

- `SHOPIFY_SHOP` (must be `9fee88-ec.myshopify.com`, the myshopifyDomain — not the
  primary domain), `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`
- `SKIO_API_KEY`
- `STRIPE_SECRET_KEY`
- `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` — once Meta is unblocked

Rotate the Stripe and Skio keys while you're doing this; both passed through a chat
window during development.

---

## 4. DNS

Add a CNAME for `analytics` pointing at Vercel, then add the domain in the Vercel
project. Vercel issues the certificate automatically.

The brief calls for this to be unlisted rather than genuinely secret — the session wall
is the actual protection, not the obscurity of the hostname.

---

## 5. Confirm the nightly sync

`vercel.json` already schedules `POST /api/sync` for 06:00 UTC daily. Vercel sends
`Authorization: Bearer $CRON_SECRET` automatically once that variable is set.

Check it by hand after deploying:

```bash
curl -X POST "https://analytics.esses.com/api/sync?source=stripe" \
  -H "x-cron-secret: $CRON_SECRET"
```

Expect JSON with `"ok": true`. A `503` means `CRON_SECRET` isn't set; a `401` means it
doesn't match; a `207` means some sources failed but the run did useful work.

> On Hobby the function timeout is 60s. Incremental sync takes about ten seconds, so
> that's fine — but it's why backfills stay local.

---

## 6. Git remote

The repo currently has **no remote**; everything is local commits. Vercel needs one.
Create a **private** GitHub repo and push. `.env` is gitignored and the tree has been
checked for credentials, but keep it private regardless — it contains real revenue
figures and customer counts in `HANDOFF.md`.

---

## 7. Adding the team

Sign in, go to **Team**, add each person as **admin** or **viewer**. You'll get a
one-time password to pass on; they change it under **Account**.

**Understand the roles before inviting anyone:**

- **Viewer** — sees *everything*: revenue, margin, customer LTV, individual customers.
- **Admin** — all of that, plus write access to costs, the margin boundary, goals,
  shipping imports and the Team page.

There is deliberately **no partial-read role**. If someone should see marketing but not
margin, that doesn't exist yet — say so rather than inviting them and hoping.

Deactivating someone takes effect immediately: `requireUser()` re-checks the account on
every page render rather than trusting the 7-day session cookie.

---

## What the team can't do yet

Worth setting expectations before they log in.

- **Meta conversion figures are wrong** and flagged as such on the Marketing page — the
  app blocks the fix, not the code (`HANDOFF.md` §5.2).
- **No social engagement data** — followers, reach, per-post performance need the same
  Meta unblock plus App Review.
- **Per-copy print cost is a placeholder**, so absolute margin is provisional. The shape
  is real; the Costs page shows exactly how much the number matters.
- **Attribution covers ~41% of revenue** until UTM tagging is rolled out. Blended MER is
  the trustworthy figure; attributed ROAS is a range.
- **No email** — no invite emails, no password-reset links, no alerts. Passwords are
  handed over manually.

---

## Rough effort

Assuming credentials to hand: **database and deploy about an hour**, backfill another
ten to twenty minutes of waiting, DNS whenever propagation completes. The genuinely
uncertain part is none of that — it's the Meta unblock, which is out of our hands.

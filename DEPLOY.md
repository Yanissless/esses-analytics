# Putting Esses Analytics online — step by step

Written to be followed start to finish with no prior knowledge. Every command is
copy-paste ready for **Windows PowerShell**, which is what's on this machine.

**Time:** about an hour of doing things, plus 15–20 minutes of waiting while data loads.
**Cost:** £0 — every service below has a free tier that comfortably fits this app.

---

## What each piece actually is

Right now the app runs only on this laptop. Four things need to change, and here's what
each one means in plain terms:

| Thing | What it actually is |
|---|---|
| **GitHub** | A website that stores code. Vercel can't read your laptop, so the code goes here first. Private, so nobody else can see it. |
| **Vercel** | The company that will run the website. You point it at GitHub and it does the rest. |
| **Neon** | The database, but online. Your data currently lives in a database on this laptop; if the laptop is off, a website can't read it. |
| **"Pooled" connection** | A setting on the Neon database. Pick the pooled option or the site will run out of database slots and start erroring under normal use. |
| **CNAME** | A DNS setting that makes `analytics.esses.com` point at Vercel. |
| **CRON_SECRET** | A password you invent, so only the automatic nightly data refresh can trigger itself. |

> **Never paste any password, key or connection string into a chat window** — including
> to me. Everything below either goes into a website form or into a file on this machine.

---

## Before you start

You'll need:

- A **GitHub** account — free, sign up at github.com
- A **Vercel** account — free, sign up at vercel.com (choose "Continue with GitHub")
- A **Neon** account — free, sign up at neon.tech (also "Continue with GitHub")
- Access to whoever manages **DNS for esses.com** (this may be you, or your web person)
- The file `C:\Users\samwi\esses-analytics\.env` on this machine — you'll copy values out
  of it

### Opening PowerShell in the right folder

You'll do this several times, so it's worth learning once:

1. Open **File Explorer** and go to `C:\Users\samwi\esses-analytics`
2. Click into the **address bar** at the top (where the folder path is)
3. Type `powershell` and press **Enter**

A blue or black window opens, already pointed at the project folder. That's where every
command below goes.

> **Anything starting with `$env:` only lasts as long as that window is open.** If you
> close PowerShell and come back, you'll need to set it again. That's normal and safe.

---

# Part 1 — Put the code on GitHub

## 1.1 Create the empty repository

1. Go to **github.com/new**
2. **Repository name:** `esses-analytics`
3. **Set it to Private.** This matters — the code contains real revenue figures in its
   notes.
4. **Do not** tick "Add a README", "Add .gitignore", or "Choose a licence". The folder
   already has all of that, and adding them here causes a conflict.
5. Click **Create repository**

You'll land on a page with setup instructions. Ignore them; use the ones below instead.

## 1.2 Push the code up

Copy the web address of your new repo from the top of that GitHub page. It looks like
`https://github.com/YOURNAME/esses-analytics.git`.

In PowerShell (in the project folder):

```powershell
git remote add origin https://github.com/YOURNAME/esses-analytics.git
```

Replace `YOURNAME` with your actual GitHub username. Then:

```powershell
git push -u origin master
```

A browser window or popup will ask you to sign in to GitHub. Do that, and the upload
starts. It takes under a minute.

**Check it worked:** refresh the GitHub page. You should see folders (`src`, `scripts`,
`drizzle`) and files like `README.md`.

> **If it says "src refspec master does not match any":** the branch might be called
> something else. Run `git branch` to see the name, and use that instead of `master`.

---

# Part 2 — Create the online database

## 2.1 Make the database

1. Go to **neon.tech** and sign in
2. Click **New Project**
3. **Name:** `esses-analytics`
4. **Postgres version:** 17 (the default is fine if 17 isn't offered)
5. **Region:** pick whichever is closest to you or your customers — US East is a safe
   default
6. Click **Create**

## 2.2 Copy the pooled connection string — this bit matters

After creating, Neon shows a **Connection string**. There's a toggle or checkbox near it
labelled **"Pooled connection"** or **"Connection pooling"**.

**Turn pooling ON, then copy the string.**

It looks like:

```
postgresql://username:password@ep-something-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Note the `-pooler` in the middle. **If your string doesn't have `-pooler` in it, you've
copied the wrong one** — go back and switch pooling on.

Why it matters: the website opens a fresh database connection for every visitor action.
Without pooling, the database runs out of allowed connections and pages start failing —
and confusingly, it works fine at first and only breaks once two or three people use it.

Paste it somewhere safe for the next few steps — Notepad is fine, just don't save the
file into the project folder.

---

# Part 3 — Set up the database structure

The database exists but is completely empty. These two commands build the tables and
create your login.

In PowerShell, in the project folder. **Replace the placeholder with your real pooled
string**, keeping the quotes:

```powershell
$env:DATABASE_URL = "postgresql://...your pooled string..."
```

Nothing appears to happen. That's correct — it just remembered the value.

Now build the tables:

```powershell
.\run.cmd db:migrate
```

Expect it to finish with `✓ Migrations applied`. Some grey `NOTICE` lines about "already
exists" are normal and harmless.

Now create your login. **Choose a real password** and put it in place of the placeholder:

```powershell
$env:SEED_ADMIN_PASSWORD = "pick-a-long-password-here"
.\run.cmd db:seed
```

That creates `sam@essesmag.com` as an admin with that password. Write the password down —
you'll need it to sign in, and you can change it in the app afterwards.

---

# Part 4 — Load the data

The database has tables but no data. This pulls everything from Shopify, Skio and Stripe.

**This runs from your laptop, not from the website.** The Shopify load walks through about
170 pages and takes roughly ten minutes, which is longer than a website is allowed to
spend on a single request. So loading data is something you do deliberately, and only the
small nightly top-up is automatic.

In the same PowerShell window (so `$env:DATABASE_URL` is still set):

```powershell
.\run.cmd backfill --since=2025-10-01 --source=shopify
```

Go and do something else for ten minutes. It prints progress as it goes. Then:

```powershell
.\run.cmd backfill --since=2025-10-01 --source=skio
.\run.cmd backfill --since=2025-10-01 --source=stripe
.\run.cmd metrics
```

`metrics` is the one that makes the dashboards work — it does the number-crunching. Expect
it to print a summary ending with figures like `MER 5.16`.

> **Don't run `--source=ads`** yet. Meta's API is blocked at the app level, so it will
> just fail. Once that's sorted, come back and run it.

> **A faster alternative:** copying your existing local database across instead of
> re-downloading everything would also bring the shipping-label costs, which currently
> can't be re-fetched because Shopify hasn't granted the reports permission. It needs a
> tool called `pg_dump` and is more fiddly — ask me if you'd rather do that.

---

# Part 5 — Deploy the website

## 5.1 Generate two passwords

The app needs two long random secrets. **Don't invent these yourself** — run this twice
in PowerShell and keep both results:

```powershell
openssl rand -base64 48
```

It prints a 64-character jumble. Run it again for a second one.

- The **first** is your `AUTH_SECRET` — it signs the login cookies
- The **second** is your `CRON_SECRET` — it protects the nightly refresh

## 5.2 Create the Vercel project

1. Go to **vercel.com** and sign in
2. Click **Add New → Project**
3. Find `esses-analytics` in the list and click **Import**
4. **Don't click Deploy yet.** Expand the **Environment Variables** section first.

## 5.3 Add the environment variables

Add each of these as a Name/Value pair. For values marked *from .env*, open
`C:\Users\samwi\esses-analytics\.env` in Notepad and copy the value after the `=` sign.

**Required:**

| Name | Value |
|---|---|
| `DATABASE_URL` | your pooled Neon string |
| `AUTH_SECRET` | the first generated secret |
| `CRON_SECRET` | the second generated secret |
| `APP_BASE_URL` | `https://analytics.esses.com` |

**Connectors — copy from `.env`:**

| Name | Notes |
|---|---|
| `SHOPIFY_SHOP` | must be `9fee88-ec.myshopify.com` — not `essesmag.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | from .env |
| `SHOPIFY_CLIENT_SECRET` | from .env |
| `SKIO_API_KEY` | from .env |
| `STRIPE_SECRET_KEY` | from .env |
| `META_ACCESS_TOKEN` | from .env — add it now even though it's currently blocked |
| `META_AD_ACCOUNT_ID` | from .env |

Then click **Deploy**. It takes two or three minutes.

When it finishes you'll get a URL like `esses-analytics-abc123.vercel.app`. **Open it and
sign in** with `sam@essesmag.com` and the password from Part 3. If the dashboard loads
with real numbers, everything above worked.

> **While you're in `.env`:** the Stripe and Skio keys were shared through a chat window
> during development. Worth generating fresh ones in those services and updating both
> `.env` and Vercel.

---

# Part 6 — The web address

## 6.1 Tell Vercel about the domain

1. In your Vercel project, go to **Settings → Domains**
2. Type `analytics.esses.com` and click **Add**
3. Vercel shows you a DNS record to create. It'll say something like:
   *Type:* `CNAME`, *Name:* `analytics`, *Value:* `cname.vercel-dns.com`

## 6.2 Create the DNS record

Wherever `esses.com`'s DNS is managed (Cloudflare, GoDaddy, Squarespace, your web
person), add a record with exactly the three values Vercel gave you.

If you're not sure who manages it, ask whoever set up the main website.

Then wait. It's usually a few minutes but can take a couple of hours. Vercel's Domains
page shows a green tick when it's live, and issues the HTTPS certificate automatically.

---

# Part 7 — Check the nightly refresh works

The app is set up to refresh its data every day at 06:00 UTC, automatically.

Test it now rather than discovering tomorrow that it doesn't. In PowerShell:

```powershell
$env:CRON_SECRET = "paste-your-second-generated-secret-here"
Invoke-WebRequest -Method POST -Uri "https://analytics.esses.com/api/sync?source=stripe" -Headers @{"x-cron-secret" = $env:CRON_SECRET} -UseBasicParsing
```

**What the answers mean:**

- **200** — working. It synced Stripe and refreshed the numbers.
- **207** — mostly working; one source failed but the rest succeeded. Fine for now.
- **401** — the `CRON_SECRET` in Vercel doesn't match what you just typed. Check for a
  stray space when you pasted it into Vercel.
- **503** — `CRON_SECRET` is missing from Vercel entirely. Add it in Settings →
  Environment Variables, then **redeploy** (Vercel only picks up new variables on a fresh
  deploy).

---

# Part 8 — Add the team

1. Sign in and click **Team** in the top navigation
2. Enter their email, pick a role, click **Add teammate**
3. **Copy the one-time password it shows you — it's shown once and never again.** Send it
   to them however you'd normally share something sensitive; not email if you can avoid
   it.
4. They sign in and change it under **Account** (click your email, top right)

### Understand the two roles before you invite anyone

- **Viewer** — sees **everything**. Revenue, margin, customer lifetime value, individual
  customer names and emails.
- **Admin** — all of the above, plus can change costs, goals, the margin setting, and add
  or remove people.

**There is no "marketing only" or "no financials" role.** If someone shouldn't see margin
and customer data, don't invite them yet — tell me and I'll build a restricted role.

Removing someone: click **Deactivate**. It takes effect immediately, not whenever their
session expires.

---

# What to tell the team on day one

Set expectations so they report real problems rather than known ones:

- **Meta's conversion numbers are wrong** and the Marketing page says so in red. Meta has
  blocked our API access; it's not a bug in the app.
- **No social engagement data** — followers, reach, per-post performance. Needs the same
  Meta unblock.
- **Print cost per copy is an estimate**, so absolute profit figures are provisional. The
  *shape* is real. The Costs page shows how much that one number matters.
- **We can only trace about 41% of revenue to a marketing channel** until UTM link
  tagging is rolled out. Blended MER is the number to trust; channel-level ROAS is a
  range, not a fact.
- **No emails from the app at all** — no invites, no password resets, no alerts.
- **Two pages can show different profit figures on purpose.** There's a setting for
  which costs count; both pages say which one they're using.

---

# If something goes wrong

**"pnpm is not recognised" or "node is not recognised"**
Use `.\run.cmd` rather than `pnpm` directly. That launcher exists specifically to fix
this.

**Website loads but says "Invalid email or password"**
Part 3's `db:seed` ran against a different database than Vercel is using. Check the
`DATABASE_URL` in Vercel matches the one you used in PowerShell exactly.

**Website shows an error page instead of the dashboard**
In Vercel, open the deployment → **Logs**. Most likely `DATABASE_URL` is missing, or is
the non-pooled string.

**Dashboards load but every number is zero**
The backfill in Part 4 ran against your laptop's database instead of Neon. Reopen
PowerShell, set `$env:DATABASE_URL` to the Neon string, and run Part 4 again.

**Pages work then start failing once a few people use it**
Non-pooled connection string. Swap it for the `-pooler` one in Vercel and redeploy.

**Anything else** — copy the error text and send it to me. Don't include the
`DATABASE_URL`, keys, or passwords.

---

# Quick reference

Everything you need, in order:

```powershell
# 1. Code to GitHub (once)
git remote add origin https://github.com/YOURNAME/esses-analytics.git
git push -u origin master

# 2-4. Database setup and data load
$env:DATABASE_URL = "postgresql://...pooled...neon.tech/neondb?sslmode=require"
$env:SEED_ADMIN_PASSWORD = "your-chosen-password"
.\run.cmd db:migrate
.\run.cmd db:seed
.\run.cmd backfill --since=2025-10-01 --source=shopify
.\run.cmd backfill --since=2025-10-01 --source=skio
.\run.cmd backfill --since=2025-10-01 --source=stripe
.\run.cmd metrics

# 5. Generate a secret (run twice — AUTH_SECRET and CRON_SECRET)
openssl rand -base64 48
```

Then: Vercel import → environment variables → Deploy → add the domain → test
`/api/sync` → add the team.

---

## Keeping it updated later

Once it's live, publishing a change is:

```powershell
git add -A
git commit -m "what changed"
git push
```

Vercel notices the push and redeploys within a couple of minutes. Nothing else to do.

**After any future backfill, always run `.\run.cmd metrics`** — the dashboards read
pre-calculated tables, and skipping it leaves the International page silently
under-reporting.

# Esses Analytics — setup for testers

**What this is:** a working copy of the internal analytics dashboard Sam's building to
replace StoreHero, running on your own laptop with a real (but point-in-time) copy of
Esses' order/subscriber/ad data. You're getting it early so you can click around, and
tell Sam what's confusing, broken, or missing before Johnny puts it on the real site.

**What Sam wants from you:** a list of things to fix or change, sent back to him
roughly weekly (Friday works, if you want a rhythm). Doesn't need to be formal — a
bullet list, screenshots, whatever's fastest for you. He'll fix what he can and send
you an updated copy the following week.

**Your login (this copy only):** Sam will tell you your email and a password
separately. Change it after you log in the first time (Account page, top right).

**Most people on this list are on a Mac** — that's the primary path below. There's a
condensed Windows path afterward for anyone who isn't.

---

## One-time setup (only do this the first week)

### Mac

Three things installed once, all through one tool (Homebrew) that handles Node,
Postgres and the package manager together.

**1. Install Homebrew**, if you don't already have it. Open **Terminal** (Spotlight
search → "Terminal") and paste:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow whatever it prints at the end — it usually asks you to run one more line to add
Homebrew to your PATH. Do that, then close and reopen Terminal.

**2. Install Node, Postgres and pnpm:**

```
brew install node postgresql@17 pnpm
brew services start postgresql@17
```

If `brew install` prints a message about postgresql@17 not being on your PATH
("keg-only"), it'll give you one or two lines to run — do those too, then close and
reopen Terminal. If a later step can't find `psql` or `pg_restore`, that PATH step is
almost certainly why; ask Sam or Claude if the message is confusing.

**3. Unzip what Sam sent you.** You should have two files:
`esses-analytics-source.zip` and `esses-analytics-data.dump`. Unzip the source zip
somewhere easy to find, e.g. `Documents/esses-analytics`. Keep the `.dump` file next
to it — you don't unzip that one, it's a database file, not an archive.

**4. Make the launcher runnable.** Zip files don't always preserve this. Open Terminal
in the unzipped folder (Finder: right-click the folder → Services → "New Terminal at
Folder", or drag the folder onto the Terminal icon) and run:

```
chmod +x START-APP.command
```

**5. Create the database and load the data**, in that same Terminal:

```
psql postgres -c "CREATE ROLE esses_app WITH LOGIN PASSWORD 'localdevpassword';"
psql postgres -c "CREATE DATABASE esses_analytics OWNER esses_app;"
pg_restore -U esses_app -d esses_analytics --no-owner esses-analytics-data.dump
```

(A handful of warnings about "role does not exist" or ownership are normal and safe to
ignore — they're about roles that exist on Sam's machine but not yours. If the first
command says `role "esses_app" already exists`, that's fine too, just carry on to the
next line.)

**6. Set up the app's configuration.** In the unzipped folder, find `.env.example`.
Make a **copy** of it, rename the copy to `.env` (no `.example`). Open `.env` in
TextEdit (or any text editor) and change just one line:

```
DATABASE_URL=postgres://esses_app:localdevpassword@localhost:5432/esses_analytics
```

Leave every other line in `.env` **blank** — this copy doesn't need any of those (Meta,
Skio, Stripe, GA4, Slack, AI) to show you the data Sam already synced. You won't be
running any live syncs from your machine.

One more line to fill in — `AUTH_SECRET` needs a random value. In Terminal, run:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Copy what it prints and paste it as the value of `AUTH_SECRET` in `.env`.

**7. Install and start.** Back in Terminal, in the unzipped folder:

```
pnpm install
```

This takes a few minutes the first time. Once it finishes, **double-click
`START-APP.command`** in Finder — a Terminal window opens and says "Starting the
server." Leave that window open, then go to **http://localhost:3000** in your browser
and log in with the account above.

If double-clicking does nothing, or macOS says it's from an unidentified developer:
right-click (or Control-click) the file and choose **Open** instead — macOS allows
that even for an unsigned script.

---

### Windows (if you're not on a Mac)

**1. Install Node.js** — [nodejs.org](https://nodejs.org), the **LTS** version,
defaults.

**2. Install PostgreSQL 17** — [postgresql.org/download](https://www.postgresql.org/download/),
Windows, defaults. It'll ask for a **superuser password** — pick one and remember it.

**3. Install pnpm** — open PowerShell and run `npm install -g pnpm`.

**4. Unzip** what Sam sent you, keeping the `.dump` file next to the unzipped folder.

**5. Create the database** — open a terminal in the unzipped folder (type `cmd` in
File Explorer's address bar, press Enter) and run:

```
psql -U postgres -c "CREATE ROLE esses_app WITH LOGIN PASSWORD 'localdevpassword';"
psql -U postgres -c "CREATE DATABASE esses_analytics OWNER esses_app;"
pg_restore -U esses_app -d esses_analytics --no-owner esses-analytics-data.dump
```

If `'psql' is not recognized`, use the full path instead:
`"C:\Program Files\PostgreSQL\17\bin\psql.exe"` (same folder for `pg_restore.exe`).

**6. Set up `.env`** — copy `.env.example` to `.env`, set `DATABASE_URL` to
`postgres://esses_app:localdevpassword@localhost:5432/esses_analytics`, leave
everything else blank, and generate `AUTH_SECRET` the same way as the Mac
instructions above (`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`).

**7. Install and start** — `pnpm install`, then double-click `START-APP.cmd`, then
open http://localhost:3000.

---

## Every week after that (much shorter)

Sam will send you a new `esses-analytics-source.zip` and `esses-analytics-data.dump`.

1. Close the app if it's running (close the Terminal window it's running in).
2. Unzip the new source zip **over your existing folder**, replacing files — say yes
   to any overwrite prompts. Your `.env` file won't be touched (it's not part of what
   Sam sends you), so you don't need to redo the configuration step above. (Mac only:
   re-run `chmod +x START-APP.command` — the overwrite may reset it to non-executable.)
3. Refresh the database with the new data:
   - **Mac:** `psql postgres -c "DROP DATABASE esses_analytics;"` then
     `psql postgres -c "CREATE DATABASE esses_analytics OWNER esses_app;"` then
     `pg_restore -U esses_app -d esses_analytics --no-owner esses-analytics-data.dump`
   - **Windows:** same three commands, with `psql -U postgres` instead of
     `psql postgres`.
4. Run `pnpm install` again (only matters if Sam added a new dependency — harmless to
   run every time).
5. Start the app again (`START-APP.command` / `START-APP.cmd`).

That's it — no need to recreate your login or redo the `.env` file.

---

## Before you report something, quick check

A few things are already known and don't need reporting (Sam's tracking them):

- **Costs/margin figures are placeholders** pending real printer invoices — anything
  under `/costs`, `/profit`, or the LTV:CAC page's "Annual" tier is flagged
  "needs confirmation" on the page itself for this reason.
- **`/content` (GA4 readership) is empty** — no credentials connected yet.
- **`/ask` (the AI analyst) says "not configured"** — no API key on this local copy.
- **Meta ad campaign tracking has a known gap** since the Craft checkout migration —
  Sam's already aware and working on it.

Anything else — confusing wording, a number that looks wrong, a page that's slow, a
button that does nothing, a workflow that's more clicks than it should be — that's
exactly the feedback Sam wants.

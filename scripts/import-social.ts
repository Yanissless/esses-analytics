/**
 * Import social follower counts.
 *
 *   pnpm import:social --file="C:\path\to\followers.csv"
 *   pnpm import:social --platform=instagram --date=2026-08-11 --followers=18240
 *
 * ## Why this exists rather than only an API sync
 *
 * Instagram's `follower_count` insight returns a rolling ~30-day window: once the Meta
 * scopes are granted, a nightly sync can keep this current, but nothing can backfill the
 * history. Correlating follower growth against subscriber growth is a question about
 * history, so the numbers have to come from somewhere else — a spreadsheet, the
 * Instagram app's own Insights screen, an old screenshot.
 *
 * Every row records its `source`, so the charts can state how much of the series was
 * observed versus hand-entered. That's the same in-line honesty the rest of the app
 * practises; a follower series that admits it was typed in is worth more than one that
 * looks authoritative and isn't.
 *
 * CSV format — header required, column order free:
 *
 *   date,platform,followers,following,posts,note
 *   2026-08-04,instagram,18102,412,1204,from IG app
 *   2026-08-11,instagram,18240,413,1209,
 *
 * `platform` defaults to --platform (or instagram); `following`, `posts` and `note` are
 * optional. Re-importing a date corrects the existing row rather than duplicating it.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { sql } from "drizzle-orm";

/**
 * Reads a file that may be UTF-16LE with a BOM.
 *
 * Meta's Instagram audience export is UTF-16LE and opens with a `sep=,` directive. Read as
 * UTF-8 it decodes to characters separated by NUL bytes, which csv-parse happily accepts
 * and turns into nonsense rather than an error — so sniff the BOM instead of assuming.
 */
function readTextFile(path: string): string {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").slice(1);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: swap byte pairs, then decode as LE.
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = t;
    }
    return swapped.toString("utf16le").slice(1);
  }
  return buf.toString("utf8").replace(/^﻿/, "");
}

import { db } from "../src/db/client";
import { logger } from "../src/lib/logger";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

interface Row {
  platform: string;
  capturedOn: string;
  followers: number;
  following: number | null;
  posts: number | null;
  source: string;
  note: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function intOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Pulls a value by any of several header spellings. */
function pick(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const hit = Object.keys(row).find((k) => k.trim().toLowerCase() === n);
    if (hit && row[hit] !== "") return row[hit];
  }
  return undefined;
}

/**
 * Parses Meta's Instagram audience export and reconstructs follower TOTALS from it.
 *
 * ## Why reconstruction is necessary, not a workaround
 *
 * The export's "Follows" block is **new follows per day** — values like 0, 1, 3 — not the
 * follower count. Meta does not publish historical totals anywhere: not in this export,
 * not in Business Suite, and not through the Graph API, where `follower_count` is also a
 * daily new-follow metric and the total is only readable as a current point-in-time field.
 * So a level series can only ever be built by walking the deltas back from one known total.
 * That is the method, not a compromise.
 *
 * What this means for trust: the deltas are exact, so the SHAPE of the reconstructed line
 * is exact. Only its vertical offset carries whatever imprecision is in the anchor — a
 * "43.3k" reading is ±50, which is larger than a month of movement at this account's growth
 * rate. That matters for reading a level off the chart and not at all for the correlation,
 * which consumes changes. The anchor and its date are recorded in each row's `note` so the
 * assumption travels with the data.
 */
function parseMetaExport(
  file: string,
  platform: string,
  anchor: number,
  anchorDateArg: string | undefined,
): Row[] {
  const text = readTextFile(file);
  const lines = text.split(/\r?\n/);

  // Find the "Follows" section, then read the date/value rows beneath its header row.
  const startIdx = lines.findIndex((l) => /^"?Follows"?\s*$/i.test(l.trim()));
  if (startIdx === -1) {
    throw new Error(
      'No "Follows" section found. This does not look like a Meta Instagram audience export — ' +
        "use --file for a plain date,platform,followers CSV instead.",
    );
  }

  const daily: Array<{ date: string; delta: number }> = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") break; // blank line ends the section
    const cells = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cells.length < 2) continue;
    if (/^date$/i.test(cells[0])) continue; // the section's own header
    const date = cells[0].slice(0, 10);
    if (!ISO_DATE.test(date)) continue;
    const delta = intOrNull(cells[1]);
    if (delta == null) continue;
    daily.push({ date, delta });
  }

  if (daily.length === 0) throw new Error('The "Follows" section parsed to 0 usable rows.');
  daily.sort((a, b) => a.date.localeCompare(b.date));

  const lastDate = daily[daily.length - 1].date;
  const anchorDate = anchorDateArg ?? lastDate;
  if (anchorDate < lastDate) {
    throw new Error(
      `--anchor-date ${anchorDate} is before the last day in the file (${lastDate}). ` +
        "Anchor on the last day or later, so the deltas can be walked backwards from it.",
    );
  }

  // Days between the file's end and a later anchor date have unknown deltas. At this
  // account's rate that is a follower or two, but state it rather than bury it.
  const gapDays = Math.round(
    (Date.parse(`${anchorDate}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / 86_400_000,
  );
  if (gapDays > 0) {
    console.log(
      `\nNote: anchor is dated ${anchorDate} but the file ends ${lastDate}. Treating ${anchor} ` +
        `as the total on ${lastDate}; any growth in those ${gapDays} day(s) is unaccounted.\n`,
    );
  }

  // Walk backwards: total(d-1) = total(d) - delta(d).
  const totals = new Array<number>(daily.length);
  totals[daily.length - 1] = anchor;
  for (let i = daily.length - 2; i >= 0; i--) totals[i] = totals[i + 1] - daily[i + 1].delta;

  const note = `reconstructed from daily follows; anchored ${anchor} on ${anchorDate}`;
  return daily.map((d, i) => ({
    platform,
    capturedOn: d.date,
    followers: totals[i],
    following: null,
    posts: null,
    source: "meta_export",
    note,
  }));
}

function parseCsv(file: string, defaultPlatform: string): Row[] {
  const text = readTextFile(file);
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const rows: Row[] = [];
  records.forEach((record, i) => {
    const line = i + 2; // header is line 1
    const date = pick(record, "date", "captured_on", "day", "week");
    const followers = intOrNull(pick(record, "followers", "follower_count", "count"));

    // A row that can't be read is an error, not a silent skip: a follower series with a
    // quietly dropped week produces a wrong growth rate rather than an obvious gap.
    if (!date || !ISO_DATE.test(date)) {
      throw new Error(`Line ${line}: missing or malformed date (want YYYY-MM-DD), got "${date ?? ""}"`);
    }
    if (followers == null || followers < 0) {
      throw new Error(`Line ${line}: missing or negative follower count`);
    }

    rows.push({
      platform: (pick(record, "platform", "channel") ?? defaultPlatform).toLowerCase(),
      capturedOn: date,
      followers,
      following: intOrNull(pick(record, "following", "following_count")),
      posts: intOrNull(pick(record, "posts", "post_count", "media_count")),
      source: "csv",
      note: pick(record, "note", "notes") ?? null,
    });
  });
  return rows;
}

async function upsert(rows: Row[]): Promise<{ written: number }> {
  let written = 0;
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO social_audience (platform, captured_on, followers, following, posts, source, note)
      VALUES (${r.platform}, ${r.capturedOn}, ${r.followers}, ${r.following}, ${r.posts}, ${r.source}, ${r.note})
      ON CONFLICT (platform, captured_on) DO UPDATE SET
        followers = EXCLUDED.followers,
        following = COALESCE(EXCLUDED.following, social_audience.following),
        posts     = COALESCE(EXCLUDED.posts,     social_audience.posts),
        source    = EXCLUDED.source,
        note      = COALESCE(EXCLUDED.note, social_audience.note),
        updated_at = now()
    `);
    written += 1;
  }
  return { written };
}

async function main() {
  const file = arg("file");
  const platform = (arg("platform") ?? "instagram").toLowerCase();

  const metaExport = arg("meta-export");
  const anchor = intOrNull(arg("anchor"));

  let rows: Row[];
  if (metaExport) {
    if (anchor == null || anchor <= 0) {
      throw new Error(
        "--meta-export needs --anchor=<current total followers>, because the export contains\n" +
          "daily NEW follows rather than totals and Meta publishes no historical total anywhere.\n" +
          'Example: pnpm import:social --meta-export="Audience.csv" --anchor=43300',
      );
    }
    rows = parseMetaExport(metaExport, platform, anchor, arg("anchor-date"));
  } else if (file) {
    rows = parseCsv(file, platform);
  } else {
    // Single-observation mode, for "I just looked at the app" entry.
    const date = arg("date");
    const followers = intOrNull(arg("followers"));
    if (!date || !ISO_DATE.test(date) || followers == null) {
      throw new Error(
        'Usage: pnpm import:social --file="path/to/followers.csv"\n' +
          '   or: pnpm import:social --meta-export="Audience.csv" --anchor=43300 [--anchor-date=2026-08-12]\n' +
          "   or: pnpm import:social --platform=instagram --date=2026-08-11 --followers=18240 [--following=412] [--posts=1209] [--note=\"...\"]",
      );
    }
    rows = [
      {
        platform,
        capturedOn: date,
        followers,
        following: intOrNull(arg("following")),
        posts: intOrNull(arg("posts")),
        source: "manual",
        note: arg("note") ?? null,
      },
    ];
  }

  if (rows.length === 0) throw new Error("Nothing to import — the file parsed to 0 rows.");

  const { written } = await upsert(rows);

  const dates = rows.map((r) => r.capturedOn).sort();
  const platforms = [...new Set(rows.map((r) => r.platform))];
  logger.info("social audience import done", {
    written,
    platforms,
    from: dates[0],
    to: dates[dates.length - 1],
  });
  console.log(
    `\nImported ${written} observation(s) for ${platforms.join(", ")}, ` +
      `${dates[0]} → ${dates[dates.length - 1]}.\n` +
      "Follower charts read this table directly — no metrics rebuild needed.\n",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("social audience import failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

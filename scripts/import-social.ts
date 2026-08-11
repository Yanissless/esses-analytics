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

function parseCsv(file: string, defaultPlatform: string): Row[] {
  const text = readFileSync(file, "utf8");
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

  let rows: Row[];
  if (file) {
    rows = parseCsv(file, platform);
  } else {
    // Single-observation mode, for "I just looked at the app" entry.
    const date = arg("date");
    const followers = intOrNull(arg("followers"));
    if (!date || !ISO_DATE.test(date) || followers == null) {
      throw new Error(
        'Usage: pnpm import:social --file="path/to/followers.csv"\n' +
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

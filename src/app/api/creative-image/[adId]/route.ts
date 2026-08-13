/**
 * Serves cached ad creative pictures.
 *
 * Exists because Meta's image URLs expire within days, so the browser cannot be pointed at
 * them — see `db/schema/marketing.ts`. The bytes live in `ad_creative` and come back through
 * here.
 *
 * ## Auth
 *
 * Behind `requireCapability("marketing")`, same as the page that renders these. An unguarded
 * image route is a common way for an internal app to leak: the pictures themselves are
 * unremarkable, but the ad IDs are enumerable and confirming which ones exist tells an
 * outsider what is being advertised and roughly how much of it there is.
 *
 * `proxy.ts` guards page routes; API routes are checked here explicitly rather than assumed.
 */

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { requireCapability } from "@/lib/auth/current-user";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ adId: string }> },
) {
  await requireCapability("marketing");
  const { adId } = await params;

  const rows = await db.execute<{ image_data: string | null; image_mime: string | null }>(sql`
    SELECT image_data, image_mime
    FROM ad_creative
    WHERE platform = 'meta' AND ad_id = ${adId}
    LIMIT 1
  `);

  const row = [...rows][0];
  if (!row?.image_data) {
    return new NextResponse(null, { status: 404 });
  }

  const buf = Buffer.from(row.image_data, "base64");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": row.image_mime ?? "image/jpeg",
      // Immutable is safe: a new picture for the same ad is a different picture, and the
      // sync writes it under the same ID — so `private` keeps it out of shared caches while
      // still letting the browser skip re-fetching within a session.
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(buf.length),
    },
  });
}

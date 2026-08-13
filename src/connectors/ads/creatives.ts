/**
 * Fetches ad creative previews from Meta and caches the picture bytes.
 *
 * Read-only: every call here is a bare `fetch(url)` with no `method`, so GET. Nothing in this
 * file can alter a post, an ad, or a creative.
 *
 * ## The cascade, and why there has to be one
 *
 * There is no single Graph field that returns a usable picture for an arbitrary ad. Probed
 * against this account, six ads deep:
 *
 *   - `creative.image_url` was null on all six.
 *   - `object_story_spec.video_data.image_url` returned a 124KB JPEG — but only for the one ad
 *     with `object_type: VIDEO`.
 *   - The other five were `object_type: SHARE` (boosted posts) and exposed nothing larger than
 *     the 64px thumbnail on the creative itself.
 *   - Reading the post directly gave a 115KB picture plus a permalink — but only through a
 *     **Page-scoped** token. The user token returns error #10 telling you to grant
 *     `pages_read_engagement`, which is already granted; the message is misleading, the real
 *     problem is the token type.
 *   - Some posts still return no `full_picture` at all.
 *
 * So each ad walks down the rungs until one produces bytes, and which rung won is recorded.
 * A page that showed a 64px thumbnail and a full-resolution asset in identically-sized tiles
 * would be implying a quality they do not share.
 *
 * ## Page tokens are not stored
 *
 * `/me/accounts` returns a token per Page. Those are credentials, so they are fetched per run,
 * held in memory, and never written to the database or logged. One extra request per sync is
 * a fair price for not having a second long-lived secret to rotate.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";

const API_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

/** How far down the cascade a picture came from. Ordered best-first. */
export type ImageSource = "creative_image" | "video_thumbnail" | "post_picture" | "thumbnail";

/** Anything above this is a real asset rather than the 64px floor. */
export const THUMBNAIL_BYTE_CEILING = 12_000;

function token(): string {
  const t = env.META_ACCESS_TOKEN;
  if (!t) throw new Error("META_ACCESS_TOKEN is not set");
  return t;
}

function accountId(): string {
  const a = env.META_AD_ACCOUNT_ID;
  if (!a) throw new Error("META_AD_ACCOUNT_ID is not set");
  return a.startsWith("act_") ? a : `act_${a}`;
}

interface GraphError {
  error?: { message?: string; code?: number };
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json()) as T & GraphError;
  if (!res.ok || body.error) {
    throw new Error(
      `${body.error?.message ?? `HTTP ${res.status}`}` +
        (body.error?.code ? ` (code ${body.error.code})` : ""),
    );
  }
  return body;
}

/**
 * Page access tokens, keyed by Page name. Held only for the life of the call.
 *
 * Returns an empty map rather than throwing when Pages are unreachable: losing the
 * `post_picture` rung degrades boosted-post ads to their 64px thumbnail, which is worse but
 * not broken, and should not cost the image and video ads their full-size previews.
 */
async function pageTokens(): Promise<string[]> {
  try {
    const r = await get<{ data?: Array<{ access_token?: string }> }>(
      `${BASE}/me/accounts?fields=name,access_token&access_token=${encodeURIComponent(token())}`,
    );
    return (r.data ?? []).map((p) => p.access_token).filter((t): t is string => Boolean(t));
  } catch (err) {
    logger.warn("could not read Page tokens — boosted-post previews will fall back to 64px", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

interface RawAd {
  id: string;
  name?: string;
  status?: string;
  campaign_id?: string;
  creative?: {
    id?: string;
    object_type?: string;
    image_url?: string;
    thumbnail_url?: string;
    effective_object_story_id?: string;
    object_story_spec?: {
      link_data?: { picture?: string };
      video_data?: { image_url?: string };
    };
  };
}

/** Every ad on the account, paginated. Metadata only — no images downloaded here. */
async function listAds(): Promise<RawAd[]> {
  const fields = [
    "id",
    "name",
    "status",
    "campaign_id",
    "creative{id,object_type,image_url,thumbnail_url,effective_object_story_id," +
      "object_story_spec{link_data{picture},video_data{image_url}}}",
  ].join(",");

  let url =
    `${BASE}/${accountId()}/ads?fields=${encodeURIComponent(fields)}` +
    `&limit=100&access_token=${encodeURIComponent(token())}`;

  const out: RawAd[] = [];
  let pages = 0;
  // Hard page cap: a paging bug that never returns an empty `next` would otherwise loop
  // until the rate limit rather than stopping.
  while (url && pages < 40) {
    const body = await get<{ data?: RawAd[]; paging?: { next?: string } }>(url);
    out.push(...(body.data ?? []));
    url = body.paging?.next ?? "";
    pages += 1;
  }
  logger.debug(`Meta ads listed: ${out.length} across ${pages} page(s)`);
  return out;
}

/** A post's picture and permalink, tried against each Page token until one answers. */
async function postPicture(
  storyId: string,
  tokens: string[],
): Promise<{ url: string; permalink: string | null } | null> {
  for (const t of tokens) {
    try {
      const p = await get<{ full_picture?: string; permalink_url?: string }>(
        `${BASE}/${storyId}?fields=full_picture,permalink_url&access_token=${encodeURIComponent(t)}`,
      );
      if (p.full_picture) return { url: p.full_picture, permalink: p.permalink_url ?? null };
      // Reached the post but it has no picture — a real answer, so stop asking other Pages.
      return null;
    } catch {
      // Wrong Page for this post. Try the next one.
    }
  }
  return null;
}

interface Resolved {
  url: string;
  source: ImageSource;
  permalink: string | null;
}

/** Walks the cascade for one ad and returns the best picture URL available. */
async function resolveImage(ad: RawAd, tokens: string[]): Promise<Resolved | null> {
  const c = ad.creative;
  if (!c) return null;

  if (c.image_url) return { url: c.image_url, source: "creative_image", permalink: null };

  const video = c.object_story_spec?.video_data?.image_url;
  if (video) return { url: video, source: "video_thumbnail", permalink: null };

  const link = c.object_story_spec?.link_data?.picture;
  if (link) return { url: link, source: "creative_image", permalink: null };

  if (c.effective_object_story_id && tokens.length > 0) {
    const post = await postPicture(c.effective_object_story_id, tokens);
    if (post) return { url: post.url, source: "post_picture", permalink: post.permalink };
  }

  // The floor. Always present, always 64x64.
  if (c.thumbnail_url) return { url: c.thumbnail_url, source: "thumbnail", permalink: null };
  return null;
}

export interface CreativeSyncResult {
  adsSeen: number;
  /** Ads that appear in `ad_spend` — the ones worth downloading a picture for. */
  adsWithSpend: number;
  imagesStored: number;
  /** Ads whose cached picture was still fresh, so nothing was re-downloaded. */
  imagesReused: number;
  bySource: Record<string, number>;
  /** Ads where every rung failed. */
  noImage: number;
}

/**
 * How long a cached picture is trusted before it is fetched again.
 *
 * The creative behind an ad ID does not change — Meta issues a new ad for a new creative — so
 * this is about picking up edits and replaced assets, not about staleness in the usual sense.
 * Without it, every run re-downloads all 651 pictures, which turns a re-run from seconds into
 * minutes and makes the command something you avoid.
 */
export const CREATIVE_REFRESH_DAYS = 30;

/**
 * Syncs creative metadata for every ad, and picture bytes for those that spent money.
 *
 * `onlyWithSpend: false` downloads everything — useful once if you want the full library, but
 * it is tens of MB and most of it is for ads that never ran.
 */
export async function syncAdCreatives(
  opts: { onlyWithSpend?: boolean; force?: boolean } = {},
): Promise<CreativeSyncResult> {
  const onlyWithSpend = opts.onlyWithSpend !== false;
  const [ads, tokens] = await Promise.all([listAds(), pageTokens()]);

  const spendRows = await db.execute<{ ad_id: string }>(sql`
    SELECT DISTINCT ad_id FROM ad_spend WHERE platform = 'meta' AND ad_id IS NOT NULL
  `);
  const spent = new Set([...spendRows].map((r) => r.ad_id));

  // Ads whose cached picture is still within the refresh window. Computed in SQL so the
  // cutoff is the database's clock, not this process's.
  const freshRows = opts.force
    ? []
    : await db.execute<{ ad_id: string }>(sql`
        SELECT ad_id FROM ad_creative
         WHERE platform = 'meta'
           AND image_data IS NOT NULL
           AND fetched_at > now() - (${CREATIVE_REFRESH_DAYS} || ' days')::interval
      `);
  const fresh = new Set([...freshRows].map((r) => r.ad_id));

  const bySource: Record<string, number> = {};
  let imagesStored = 0;
  let imagesReused = 0;
  let noImage = 0;
  let adsWithSpend = 0;

  for (const ad of ads) {
    const hasSpend = spent.has(ad.id);
    if (hasSpend) adsWithSpend += 1;

    if (fresh.has(ad.id)) {
      // Metadata still gets refreshed below via the null-image path; the COALESCE in the
      // upsert keeps the existing picture untouched.
      imagesReused += 1;
    }

    let imageData: string | null = null;
    let imageMime: string | null = null;
    let imageSource: string | null = null;
    let imageBytes: number | null = null;
    let permalink: string | null = null;

    if ((hasSpend || !onlyWithSpend) && !fresh.has(ad.id)) {
      const resolved = await resolveImage(ad, tokens);
      if (resolved) {
        permalink = resolved.permalink;
        try {
          const res = await fetch(resolved.url);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            imageData = buf.toString("base64");
            imageMime = res.headers.get("content-type") ?? "image/jpeg";
            imageSource = resolved.source;
            imageBytes = buf.length;
            bySource[resolved.source] = (bySource[resolved.source] ?? 0) + 1;
            imagesStored += 1;
          }
        } catch {
          // A CDN failure on one picture must not abort the whole sync.
        }
      }
      if (!imageData) noImage += 1;
    }

    // Metadata is always written; the image columns only overwrite when we actually got
    // bytes, so a failed download never blanks a picture cached on an earlier run.
    await db.execute(sql`
      INSERT INTO ad_creative
        (platform, ad_id, ad_name, campaign_id, creative_id, object_type, status,
         image_data, image_mime, image_source, image_bytes, permalink, fetched_at)
      VALUES ('meta', ${ad.id}, ${ad.name ?? null}, ${ad.campaign_id ?? null},
              ${ad.creative?.id ?? null}, ${ad.creative?.object_type ?? null},
              ${ad.status ?? null}, ${imageData}, ${imageMime}, ${imageSource},
              ${imageBytes}, ${permalink}, ${imageData ? sql`now()` : sql`NULL`})
      ON CONFLICT (platform, ad_id) DO UPDATE SET
        ad_name     = EXCLUDED.ad_name,
        campaign_id = EXCLUDED.campaign_id,
        creative_id = EXCLUDED.creative_id,
        object_type = EXCLUDED.object_type,
        status      = EXCLUDED.status,
        image_data   = COALESCE(EXCLUDED.image_data,   ad_creative.image_data),
        image_mime   = COALESCE(EXCLUDED.image_mime,   ad_creative.image_mime),
        image_source = COALESCE(EXCLUDED.image_source, ad_creative.image_source),
        image_bytes  = COALESCE(EXCLUDED.image_bytes,  ad_creative.image_bytes),
        permalink    = COALESCE(EXCLUDED.permalink,    ad_creative.permalink),
        fetched_at   = COALESCE(EXCLUDED.fetched_at,   ad_creative.fetched_at),
        updated_at   = now()
    `);
  }

  const result: CreativeSyncResult = {
    adsSeen: ads.length,
    adsWithSpend,
    imagesStored,
    imagesReused,
    bySource,
    noImage,
  };
  logger.info("ad creative sync done", { ...result });
  return result;
}

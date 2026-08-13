/**
 * Creative preview tiles.
 *
 * Server Component — no interaction, so it stays off the client boundary and cannot hit the
 * serialization trap that has bitten this codebase three times. Plain `<img>` rather than
 * `next/image`: the bytes come from our own route with no external host to whitelist, and
 * `next/image` would add an optimisation pass over pictures that are already small.
 *
 * ## Thumbnail-only creatives are drawn smaller, on purpose
 *
 * Meta serves 64x64 for `thumbnail_url` and silently ignores any width/height you ask for, so
 * for 339 of the 651 cached creatives that is genuinely all there is. Stretching those into
 * the same tile as a full-resolution asset would present a blurry upscale as if it were the
 * real creative — the visual equivalent of quoting a number without its boundary. They render
 * at their native size inside the tile, with the reason on the label.
 */

import type { CreativeMedia } from "@/attribution/creatives";

/** Human labels for the cascade rungs. */
const SOURCE_LABEL: Record<string, string> = {
  creative_image: "creative asset",
  video_thumbnail: "video frame",
  post_picture: "boosted post",
  thumbnail: "64px only",
};

export function CreativeThumb({
  adId,
  adName,
  media,
  size = 96,
}: {
  adId: string | null;
  adName: string | null;
  media: CreativeMedia | undefined;
  size?: number;
}) {
  const label = adName ?? adId ?? "(unnamed)";

  if (!adId || !media) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-[10px] text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
        style={{ width: size, height: size }}
        title={
          adId
            ? "No preview cached — run `run.cmd sync:creatives`"
            : "This row has no ad ID, so there is nothing to look up"
        }
      >
        no preview
      </div>
    );
  }

  // A 64px source is shown at 64px inside the tile rather than stretched to fill it.
  const rendered = media.thumbnailOnly ? Math.min(64, size) : size;

  const img = (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- served from our own route; see the note above */}
      <img
        src={`/api/creative-image/${encodeURIComponent(adId)}`}
        alt={`Creative preview for ${label}`}
        width={rendered}
        height={rendered}
        loading="lazy"
        className="object-cover"
        style={{ width: rendered, height: rendered }}
      />
      {media.objectType === "VIDEO" ? (
        <span
          className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] leading-tight text-white"
          title="Video ad — this is the poster frame"
        >
          video
        </span>
      ) : null}
    </div>
  );

  const title = `${label} · ${SOURCE_LABEL[media.imageSource ?? ""] ?? media.imageSource ?? "unknown source"}${
    media.status && media.status !== "ACTIVE" ? ` · ${media.status.toLowerCase()}` : ""
  }`;

  // Link out to the live post when there is one, so someone can go look at the real thing.
  return media.permalink ? (
    <a
      href={media.permalink}
      target="_blank"
      rel="noopener noreferrer"
      title={`${title} — open on Facebook`}
      className="shrink-0"
    >
      {img}
    </a>
  ) : (
    <div title={title}>{img}</div>
  );
}

/**
 * A row of previews for a campaign's top creatives.
 *
 * Capped at eight: past that the row wraps into a wall of pictures that is harder to scan than
 * the table underneath it, and the tail is by definition the low-spend creatives.
 */
export function CreativeStrip({
  creatives,
  mediaById,
  limit = 8,
}: {
  creatives: Array<{ adId: string | null; adName: string | null }>;
  mediaById: Map<string, CreativeMedia>;
  limit?: number;
}) {
  const shown = creatives.filter((c) => c.adId && mediaById.has(c.adId)).slice(0, limit);
  if (shown.length === 0) return null;

  const hidden = creatives.filter((c) => c.adId && mediaById.has(c.adId)).length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map((c) => (
        <CreativeThumb
          key={c.adId as string}
          adId={c.adId}
          adName={c.adName}
          media={mediaById.get(c.adId as string)}
          size={80}
        />
      ))}
      {hidden > 0 ? (
        <span className="text-xs text-neutral-400 dark:text-neutral-500">+{hidden} more</span>
      ) : null}
    </div>
  );
}

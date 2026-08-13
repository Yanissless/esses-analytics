/**
 * Cache ad creative previews from Meta.
 *
 *   pnpm sync:creatives           metadata for every ad, pictures for ads that spent money
 *   pnpm sync:creatives --all     pictures for every ad, including ones that never ran
 *   pnpm sync:creatives --force   re-download pictures already cached
 *
 * Picture bytes are cached because Meta's image URLs expire in a few days — see the note in
 * `db/schema/marketing.ts`. Re-run it whenever new creatives go live.
 */
import "dotenv/config";
import { syncAdCreatives, THUMBNAIL_BYTE_CEILING } from "../src/connectors/ads/creatives";
import { logger } from "../src/lib/logger";

const LABELS: Record<string, string> = {
  creative_image: "creative asset (full size)",
  video_thumbnail: "video poster frame (full size)",
  post_picture: "boosted post picture (full size)",
  thumbnail: `64x64 thumbnail only (under ${THUMBNAIL_BYTE_CEILING / 1000}KB)`,
};

async function main() {
  const all = process.argv.includes("--all");
  const force = process.argv.includes("--force");
  const r = await syncAdCreatives({ onlyWithSpend: !all, force });

  console.log("\nAd creatives");
  console.log(`  ads on account       ${r.adsSeen}`);
  console.log(`  ads with spend       ${r.adsWithSpend}${all ? " (fetching all anyway)" : ""}`);
  console.log(`  pictures downloaded  ${r.imagesStored}`);
  console.log(`  already cached       ${r.imagesReused} (skipped — pass --force to refetch)`);
  console.log(`  no picture at all    ${r.noImage}`);

  if (Object.keys(r.bySource).length > 0) {
    console.log("\n  by source:");
    for (const [src, n] of Object.entries(r.bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${LABELS[src] ?? src}`);
    }
  }
  const thumbOnly = r.bySource.thumbnail ?? 0;
  if (thumbOnly > 0) {
    console.log(
      `\n  ${thumbOnly} creative(s) only have the 64px thumbnail. Meta ignores width/height\n` +
        "  on that field, so that is genuinely all it will serve for them — the page labels\n" +
        "  these rather than upscaling and pretending otherwise.",
    );
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("creative sync failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

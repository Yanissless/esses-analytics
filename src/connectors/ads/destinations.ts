/**
 * Where an ad actually sends people, and whether it carries tracking.
 *
 * ## Why this is worth its own module
 *
 * On 31 Aug 2026 all 57 active ads were found pointing at `esses.com/checkout?checkoutLink=…` —
 * Craft, not Shopify — and 56 of the 57 carried no UTMs. A click landing on Craft produces no
 * Shopify touchpoint at all, so that spend is invisible rather than merely untagged: traceable
 * paid-meta touchpoints fell from 42 in week 33 to 7 and 10 in the weeks after, while spend held
 * around $1,800 a week.
 *
 * Nothing in the app noticed, and the reason is worth stating: the tagging figures on
 * `/creatives` read 100% throughout, because they measure the touchpoints that DO arrive. When
 * ads stop producing touchpoints entirely, a coverage measure built on touchpoints gets *better*
 * as the problem gets worse. The destination is the only fact that would have caught it, and it
 * was being fetched from Meta and thrown away.
 */

/** The creative shape these read, kept loose because Meta omits whatever does not apply. */
export interface CreativeLinkFields {
  url_tags?: string;
  object_story_spec?: {
    link_data?: {
      link?: string;
      child_attachments?: Array<{ link?: string }>;
    };
    video_data?: { call_to_action?: { value?: { link?: string } } };
  };
  asset_feed_spec?: { link_urls?: Array<{ website_url?: string }> };
}

/**
 * Every destination URL a creative carries.
 *
 * There is no single destination field, which is the trap. A link ad uses
 * `link_data.link`; a carousel puts one per card in `child_attachments`; a video ad hides it
 * under the call-to-action; Advantage+ ads use `asset_feed_spec.link_urls`. Reading only the
 * first would report "no destination" for most of this account.
 */
export function adDestinations(creative: CreativeLinkFields | undefined | null): string[] {
  if (!creative) return [];
  const out: string[] = [];

  const link = creative.object_story_spec?.link_data?.link;
  if (link) out.push(link);

  for (const card of creative.object_story_spec?.link_data?.child_attachments ?? []) {
    if (card.link) out.push(card.link);
  }

  const cta = creative.object_story_spec?.video_data?.call_to_action?.value?.link;
  if (cta) out.push(cta);

  for (const asset of creative.asset_feed_spec?.link_urls ?? []) {
    if (asset.website_url) out.push(asset.website_url);
  }

  return out;
}

/** Hostname of a URL, lowercased, or null when it will not parse. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Does this ad carry UTMs?
 *
 * Both mechanisms are in use here: Meta's own `url_tags` field, and tags appended directly to the
 * destination URL. Checking only `url_tags` would report the account as almost entirely untagged,
 * because it was set on 1 of 200 ads while the tagging was really on the URLs.
 */
export function taggedForTracking(creative: CreativeLinkFields | undefined | null): boolean {
  if (!creative) return false;
  if (creative.url_tags?.includes("utm_")) return true;
  return adDestinations(creative).some((d) => d.includes("utm_"));
}

/**
 * Hosts whose traffic this app can actually observe.
 *
 * A click here lands on Shopify, so Shopify records the visit and its UTMs and we read them off
 * the order. Anywhere else — Craft, a landing-page tool, a link shortener — the click is real,
 * the spend is real, and no touchpoint is ever created.
 *
 * Deliberately narrow. The cost of wrongly calling a host observable is silent blindness, which
 * is exactly what happened; the cost of wrongly calling one unobservable is a warning somebody
 * dismisses in ten seconds.
 */
export const OBSERVABLE_HOSTS = [
  "essesmag.myshopify.com",
  "myshopify.com",
  "shop.app",
  "shopify.com",
] as const;

export function isObservableHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return OBSERVABLE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

export interface DestinationVerdict {
  host: string | null;
  observable: boolean;
  tagged: boolean;
  /** One line explaining what this means for attribution. */
  note: string;
}

/**
 * What an ad's destination means for whether we can measure it.
 *
 * The order of these branches matters. An unobservable destination is the more serious finding
 * and it makes the tagging question moot, so it is reported first: tagging an ad that bypasses
 * Shopify changes nothing at all, and telling somebody to go and tag it would waste their time
 * on the wrong fix.
 */
export function verdictFor(creative: CreativeLinkFields | undefined | null): DestinationVerdict {
  const dests = adDestinations(creative);
  const host = hostOf(dests[0]);
  const tagged = taggedForTracking(creative);
  const observable = isObservableHost(host);

  if (dests.length === 0) {
    return {
      host: null,
      observable: false,
      tagged,
      note: "No destination found on the creative — nothing to check.",
    };
  }
  if (!observable) {
    return {
      host,
      observable: false,
      tagged,
      note:
        `Sends people to ${host}, which is not Shopify, so no touchpoint is ever recorded. ` +
        `Tagging this ad would change nothing until that site forwards the tags to checkout.`,
    };
  }
  if (!tagged) {
    return {
      host,
      observable: true,
      tagged: false,
      note: "Lands on Shopify but carries no UTMs, so the visit is seen without knowing which ad it was.",
    };
  }
  return { host, observable: true, tagged: true, note: "Traceable end to end." };
}

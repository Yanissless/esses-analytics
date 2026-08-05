/**
 * Channel normalisation (Section 8.2 — "design the channel field as an open set").
 *
 * Shopify's customer journey gives us `source` (e.g. "Instagram", "direct"),
 * `referrerUrl`, and `utmParameters` when links are tagged. This turns that mess
 * into a stable channel taxonomy without losing the raw values, which stay on the
 * touchpoint row for audit.
 *
 * A deliberate distinction that most dashboards blur: **paid vs organic social**.
 * An Instagram referral with no click id and no paid UTM is organic reach, not an
 * ad. Lumping them together would credit ad spend for free traffic — which is
 * exactly the mistake this project exists to avoid. When we can't tell, we say
 * `social-unknown` rather than guessing.
 */

/** Open set — new values are allowed without a schema change. */
export type Channel =
  | "paid-meta"
  | "paid-google"
  | "paid-tiktok"
  | "paid-other"
  | "organic-social"
  | "social-unknown"
  | "organic-search"
  | "newsletter"
  | "onsite"
  | "referral"
  /**
   * Self-referral: the visit came from one of our own domains (site → checkout,
   * Shopify's own checkout host, staging, etc.). NOT an acquisition channel — it's
   * internal navigation. Treated like `direct` so last-non-direct looks past it for
   * the real acquiring touch. Left as its own value rather than merged into direct
   * so the volume stays visible.
   */
  | "internal"
  | "direct"
  | "unknown";

/**
 * Domains that are ours (or checkout infrastructure). A referrer on this list is
 * internal navigation, not acquisition.
 *
 * Discovered the hard way: www.essesmag.com alone produced 748 touchpoints and made
 * "referral" look like the single biggest channel at $34K attributed, when it was
 * really the site handing off to checkout. Extend via OWN_DOMAINS in env.
 */
export const DEFAULT_OWN_DOMAINS = [
  "essesmag.com",
  "esses.com",
  "essesmag.myshopify.com",
  "myshopify.com",
  "shopify.com",
  "shop.app",
  "esses.webflow.io",
  "goodfolks.workers.dev",
  "checkout.shopify.com",
];

function ownDomains(): string[] {
  const extra = (process.env.OWN_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_OWN_DOMAINS, ...extra];
}

/** True when a referrer host belongs to us (exact or subdomain match). */
export function isOwnDomain(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ownDomains().some((d) => h === d || h.endsWith(`.${d}`));
}

export interface ChannelSignals {
  /** Shopify's `source` on the visit, e.g. "Instagram", "direct", "google". */
  source?: string | null;
  /** Shopify's `sourceType` (MarketingTactic enum) when present. */
  sourceType?: string | null;
  referrerUrl?: string | null;
  landingPage?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  /** fbclid / gclid / ttclid etc., parsed from the landing page. */
  clickId?: string | null;
  clickIdType?: string | null;
}

const PAID_MEDIUMS = new Set([
  "cpc",
  "ppc",
  "paid",
  "paidsocial",
  "paid_social",
  "paid-social",
  "cpm",
  "display",
  "retargeting",
]);

/**
 * Mediums that explicitly declare traffic as UNPAID. Kept separate from merely
 * "absent from PAID_MEDIUMS" so a deliberate `utm_medium=organic_social` counts as
 * evidence rather than as a missing value.
 *
 * This matters because a social post link opened inside an app often arrives with
 * no referrer at all, which would otherwise land in `direct` and lose the channel
 * entirely. Tagging organic posts is therefore worth asking for — and reading
 * `utm_source` below is what makes those tags actually count.
 */
const ORGANIC_MEDIUMS = new Set([
  "organic",
  "organicsocial",
  "organic_social",
  "organic-social",
  "social",
  "post",
  "bio",
  "story",
  "reel",
]);

const META_HOSTS = ["instagram.com", "facebook.com", "fb.com", "m.facebook.com", "l.facebook.com"];
const SEARCH_HOSTS = ["google.", "bing.com", "duckduckgo.com", "yahoo.", "ecosia.org"];

function host(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Extract a known click id from a landing-page URL. */
export function parseClickId(
  landingPage: string | null | undefined,
): { clickId: string; clickIdType: string } | null {
  if (!landingPage) return null;
  let params: URLSearchParams;
  try {
    params = new URL(landingPage).searchParams;
  } catch {
    return null;
  }
  const known: Array<[string, string]> = [
    ["fbclid", "meta"],
    ["gclid", "google"],
    ["gbraid", "google"],
    ["wbraid", "google"],
    ["ttclid", "tiktok"],
    ["msclkid", "microsoft"],
    ["epik", "pinterest"],
    ["li_fat_id", "linkedin"],
  ];
  for (const [key, type] of known) {
    const v = params.get(key);
    if (v) return { clickId: v, clickIdType: type };
  }
  return null;
}

/** Extract UTM params from a landing-page URL (Shopify's own utmParameters wins). */
export function parseUtms(landingPage: string | null | undefined): {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
} {
  const empty = { utmSource: null, utmMedium: null, utmCampaign: null };
  if (!landingPage) return empty;
  try {
    const p = new URL(landingPage).searchParams;
    return {
      utmSource: p.get("utm_source"),
      utmMedium: p.get("utm_medium"),
      utmCampaign: p.get("utm_campaign"),
    };
  } catch {
    return empty;
  }
}

/**
 * Resolve a channel from the available signals.
 *
 * Precedence: click id (hard evidence of a paid click) → paid UTM medium →
 * newsletter/on-site markers → organic social/search by referrer → referral →
 * direct. Anything unresolvable stays `unknown` rather than being bucketed into
 * direct, so "we don't know" is visible instead of inflating direct.
 */
export function resolveChannel(s: ChannelSignals): Channel {
  const src = (s.source ?? "").toLowerCase().trim();
  const medium = (s.utmMedium ?? "").toLowerCase().trim();
  const utmSource = (s.utmSource ?? "").toLowerCase().trim();
  const refHost = host(s.referrerUrl);
  const isPaidMedium = PAID_MEDIUMS.has(medium.replace(/\s+/g, ""));

  // 1. A click id is unambiguous proof of a paid click.
  switch (s.clickIdType) {
    case "meta":
      return "paid-meta";
    case "google":
    case "microsoft":
      return s.clickIdType === "google" ? "paid-google" : "paid-other";
    case "tiktok":
      return "paid-tiktok";
    case "pinterest":
    case "linkedin":
      return "paid-other";
  }

  // 2. Paid intent declared via UTM medium.
  if (isPaidMedium) {
    if (/facebook|instagram|meta|ig|fb/.test(utmSource)) return "paid-meta";
    if (/google|adwords|gads/.test(utmSource)) return "paid-google";
    if (/tiktok/.test(utmSource)) return "paid-tiktok";
    return "paid-other";
  }

  // 3. Owned channels — explicit markers only.
  if (/newsletter|email|mailgun/.test(medium) || /newsletter|email/.test(utmSource)) {
    return "newsletter";
  }
  if (/onsite|house|self[-_]?promo/.test(medium) || /onsite|house/.test(utmSource)) {
    return "onsite";
  }

  // 4. Organic social — a social host or an explicitly-unpaid social tag.
  //
  // `utmSource` is consulted here as well as the referrer/source, but ONLY after
  // the paid checks above have already returned, so a tagged paid click can never
  // be demoted to organic by this branch. An in-app tap with no referrer is the
  // case this rescues.
  const declaredOrganic = ORGANIC_MEDIUMS.has(medium.replace(/\s+/g, ""));
  const socialSignals = `${refHost} ${src}${declaredOrganic ? ` ${utmSource}` : ""}`;

  if (META_HOSTS.some((h) => refHost.endsWith(h)) || /instagram|facebook|meta/.test(socialSignals)) {
    return "organic-social";
  }
  if (/tiktok|pinterest|reddit|twitter|x\.com|threads|linkedin|youtube/.test(socialSignals)) {
    return "organic-social";
  }

  // 5. Organic search.
  if (SEARCH_HOSTS.some((h) => refHost.includes(h)) || src === "google" || src === "bing") {
    return "organic-search";
  }

  // 6. Self-referral — our own site or checkout host handing off. Checked BEFORE
  // generic referral so internal navigation can't masquerade as acquisition.
  if (refHost && isOwnDomain(refHost)) return "internal";

  // 7. Direct / referral / unknown.
  if (src === "direct" || (!refHost && !src)) return "direct";
  if (refHost) return "referral";
  if (src) return "social-unknown";
  return "unknown";
}

/** True when a channel represents paid media (so ad spend should attach to it). */
export function isPaidChannel(c: Channel): boolean {
  return c.startsWith("paid-");
}

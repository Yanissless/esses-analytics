/**
 * Ingest Shopify's customer journey into `attribution_touchpoints`.
 *
 * Shopify already tracks the pre-purchase journey (`customerJourneySummary`:
 * firstVisit, lastVisit, and the full `moments` list), which means historical
 * attribution works without deploying a first-party pixel first. Verified live on
 * this store: `ready: true`, sources like "Instagram" / "direct", referrer URLs,
 * and `utmParameters` once links are tagged.
 *
 * Observed reality worth knowing: most orders currently have ONE touchpoint and no
 * UTMs, because Instagram traffic is organic and untagged. Multi-touch models will
 * stay close to single-touch until paid campaigns with tagged links start running
 * — the engine is correct either way, but don't expect a rich path yet.
 *
 * Section 8.5: for subscription orders, the whole subscription's value belongs to
 * the ACQUISITION touchpoint, so `customers.acquisition_channel` is stamped from
 * the first order's journey and later renewals inherit it rather than being
 * re-attributed to whatever happened to bring them back.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { attributionTouchpoints } from "../db/schema";
import { logger } from "../lib/logger";
import { parseClickId, parseUtms, resolveChannel } from "./channels";

export interface JourneyVisit {
  occurredAt?: string | null;
  source?: string | null;
  sourceType?: string | null;
  referrerUrl?: string | null;
  landingPage?: string | null;
  utmParameters?: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    content?: string | null;
    term?: string | null;
  } | null;
}

export interface JourneySummary {
  ready?: boolean | null;
  daysToConversion?: number | null;
  customerOrderIndex?: number | null;
  firstVisit?: JourneyVisit | null;
  lastVisit?: JourneyVisit | null;
  moments?: { edges?: Array<{ node?: JourneyVisit | null }> } | null;
}

export interface TouchpointInput {
  customerId: string | null;
  orderId: string;
  channel: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  clickId: string | null;
  clickIdType: string | null;
  landingUrl: string | null;
  referrer: string | null;
  occurredAt: Date;
}

/**
 * Turn a journey summary into touchpoint rows. Deduplicates visits that share an
 * (occurredAt, channel) pair — Shopify often reports the same visit as both
 * firstVisit and lastVisit on a single-touch order, and counting it twice would
 * double the path length and halve each touch's credit under linear attribution.
 */
export function mapJourneyToTouchpoints(
  journey: JourneySummary | null | undefined,
  ctx: { customerId: string | null; orderId: string; fallbackAt: Date },
): TouchpointInput[] {
  if (!journey) return [];

  const visits: JourneyVisit[] = [];
  if (journey.firstVisit) visits.push(journey.firstVisit);
  for (const e of journey.moments?.edges ?? []) if (e?.node) visits.push(e.node);
  if (journey.lastVisit) visits.push(journey.lastVisit);

  const seen = new Set<string>();
  const out: TouchpointInput[] = [];

  for (const v of visits) {
    const occurredAt = v.occurredAt ? new Date(v.occurredAt) : ctx.fallbackAt;
    const click = parseClickId(v.landingPage);
    const urlUtms = parseUtms(v.landingPage);

    // Shopify's parsed utmParameters wins; fall back to parsing the landing page.
    const utmSource = v.utmParameters?.source ?? urlUtms.utmSource;
    const utmMedium = v.utmParameters?.medium ?? urlUtms.utmMedium;
    const utmCampaign = v.utmParameters?.campaign ?? urlUtms.utmCampaign;

    const channel = resolveChannel({
      source: v.source,
      sourceType: v.sourceType,
      referrerUrl: v.referrerUrl,
      landingPage: v.landingPage,
      utmSource,
      utmMedium,
      utmCampaign,
      clickId: click?.clickId ?? null,
      clickIdType: click?.clickIdType ?? null,
    });

    const key = `${occurredAt.toISOString()}|${channel}|${utmCampaign ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      customerId: ctx.customerId,
      orderId: ctx.orderId,
      channel,
      source: v.source ?? utmSource ?? null,
      medium: utmMedium ?? null,
      campaign: utmCampaign ?? null,
      content: v.utmParameters?.content ?? null,
      term: v.utmParameters?.term ?? null,
      clickId: click?.clickId ?? null,
      clickIdType: click?.clickIdType ?? null,
      landingUrl: v.landingPage ?? null,
      referrer: v.referrerUrl ?? null,
      occurredAt,
    });
  }

  return out;
}

/**
 * Persist touchpoints for one order. Replaces any prior rows for that order so
 * re-ingesting is idempotent (the journey can change as Shopify backfills it).
 */
export async function saveTouchpoints(
  orderId: string,
  touchpoints: TouchpointInput[],
): Promise<number> {
  await db.execute(sql`DELETE FROM attribution_touchpoints WHERE order_id = ${orderId}`);
  if (!touchpoints.length) return 0;

  for (const t of touchpoints) {
    await db.insert(attributionTouchpoints).values({
      customerId: t.customerId,
      sessionId: null,
      occurredAt: t.occurredAt,
      channel: t.channel,
      source: t.source,
      medium: t.medium,
      campaign: t.campaign,
      content: t.content,
      term: t.term,
      clickId: t.clickId,
      clickIdType: t.clickIdType,
      landingUrl: t.landingUrl,
      referrer: t.referrer,
      orderId: t.orderId,
    });
  }
  return touchpoints.length;
}

/**
 * Stamp each customer's acquisition channel/campaign from the touchpoints on their
 * ACQUISITION order (Section 8.5). Renewals then inherit that channel rather than
 * being credited to whatever brought them back, so a channel that acquires
 * high-LTV subscribers gets the credit it's due.
 *
 * Uses last-non-direct within the acquisition order's own path, which is the model
 * platforms use and therefore the fairest basis for comparison.
 */
export async function stampAcquisitionChannels(): Promise<number> {
  const res = await db.execute(sql`
    WITH acq AS (
      SELECT o.customer_id, o.id AS order_id, o.processed_at
        FROM orders o
       WHERE o.acquisition_order = true AND o.customer_id IS NOT NULL
    ),
    chosen AS (
      -- 'internal' is a self-referral (our site → checkout), never an acquisition
      -- channel: excluded outright so it can't be inherited by later renewals.
      -- Among what's left, prefer a real channel over direct/unknown, then most
      -- recent — i.e. last-non-direct within the acquisition order's own path.
      SELECT acq.customer_id,
             (ARRAY_AGG(t.channel ORDER BY
                (t.channel NOT IN ('direct','unknown')) DESC, t.occurred_at DESC))[1] AS channel,
             (ARRAY_AGG(t.campaign ORDER BY
                (t.channel NOT IN ('direct','unknown')) DESC, t.occurred_at DESC))[1] AS campaign,
             MIN(t.occurred_at) AS first_seen
        FROM acq
        JOIN attribution_touchpoints t ON t.order_id = acq.order_id
       WHERE t.channel <> 'internal'
       GROUP BY acq.customer_id
    )
    UPDATE customers c
       SET acquisition_channel = chosen.channel,
           acquisition_campaign = chosen.campaign,
           acquired_at = COALESCE(c.acquired_at, chosen.first_seen)
      FROM chosen
     WHERE c.id = chosen.customer_id
       AND (c.acquisition_channel IS DISTINCT FROM chosen.channel
            OR c.acquisition_campaign IS DISTINCT FROM chosen.campaign)
  `);
  const n = (res as unknown as { count?: number }).count ?? 0;
  logger.info("Acquisition channels stamped", { customersUpdated: n });
  return n;
}

/** Cart attributes as Shopify returns them. */
export interface OrderAttribute {
  key?: string | null;
  value?: string | null;
}

/** Attribute keys we read, mapped to the touchpoint field they populate. */
const ATTRIBUTE_KEYS: Record<string, keyof Pick<
  TouchpointInput,
  "source" | "medium" | "campaign" | "content" | "term"
>> = {
  utm_source: "source",
  utm_medium: "medium",
  utm_campaign: "campaign",
  utm_content: "content",
  utm_term: "term",
};

const CLICK_ID_KEYS: Array<[string, string]> = [
  ["fbclid", "meta"],
  ["gclid", "google"],
  ["ttclid", "tiktok"],
];

/**
 * Build a touchpoint from attribution the STOREFRONT attached to the order.
 *
 * ## Why this outranks Shopify's own journey
 *
 * Ads point at esses.com (Craft); checkout happens in Shopify. Shopify's analytics only see
 * pages Shopify serves, so `customerJourneySummary` for this business records the checkout
 * and nothing before it — measured over 30 recent orders, every `landingPageUrl` was a
 * checkout URL and not one carried a UTM. The journey is therefore not wrong so much as
 * blind to everything that matters: it can tell you the referrer was instagram.com, but
 * never which ad.
 *
 * A cart attribute travels WITH the cart rather than being inferred from a page view, so it
 * survives the handoff. When one is present it is first-party, exact, and set by our own
 * site — strictly better evidence than a referrer host, so it is emitted as its own
 * touchpoint stamped at the order time.
 *
 * Returns null when no attribution attributes are present, which is every order until
 * esses.com ships its half. See `docs/esses-com-attribution.md`.
 */
export function mapOrderAttributesToTouchpoint(
  attributes: OrderAttribute[] | null | undefined,
  ctx: { customerId: string | null; orderId: string; occurredAt: Date },
): TouchpointInput | null {
  if (!attributes || attributes.length === 0) return null;

  const bag = new Map<string, string>();
  for (const a of attributes) {
    const k = (a?.key ?? "").trim().toLowerCase();
    const v = (a?.value ?? "").trim();
    if (k && v) bag.set(k, v);
  }
  if (bag.size === 0) return null;

  const out: Partial<TouchpointInput> = {};
  let any = false;
  for (const [key, field] of Object.entries(ATTRIBUTE_KEYS)) {
    const v = bag.get(key);
    if (v) {
      out[field] = v;
      any = true;
    }
  }

  let clickId: string | null = null;
  let clickIdType: string | null = null;
  for (const [key, type] of CLICK_ID_KEYS) {
    const v = bag.get(key);
    if (v) {
      clickId = v;
      clickIdType = type;
      any = true;
      break;
    }
  }

  // A referrer alone is not attribution — Shopify's journey already supplies that, and
  // emitting a duplicate touchpoint for it would inflate path length under linear
  // attribution without adding information.
  if (!any) return null;

  const landingUrl = bag.get("landing_page") ?? null;
  const referrer = bag.get("referrer") ?? null;

  const channel = resolveChannel({
    utmSource: out.source ?? null,
    utmMedium: out.medium ?? null,
    utmCampaign: out.campaign ?? null,
    landingPage: landingUrl,
    referrerUrl: referrer,
    clickId,
    clickIdType,
  });

  return {
    customerId: ctx.customerId,
    orderId: ctx.orderId,
    channel,
    source: out.source ?? null,
    medium: out.medium ?? null,
    campaign: out.campaign ?? null,
    content: out.content ?? null,
    term: out.term ?? null,
    clickId,
    clickIdType,
    landingUrl,
    referrer,
    occurredAt: ctx.occurredAt,
  };
}

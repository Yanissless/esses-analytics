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

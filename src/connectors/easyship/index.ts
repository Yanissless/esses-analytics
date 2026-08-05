/**
 * EasyShip connector — actual shipping + prepaid duties per shipment.
 *
 * Why this matters: international subscription and comp shipments go out DDP
 * (duties/taxes prepaid) through the EasyShip Shopify app. Those orders collect
 * $0 from the customer, so the EasyShip charge is pure cost that is otherwise
 * invisible — exactly the leak the zone estimate can't see.
 *
 * ⚠️ UNVERIFIED AGAINST LIVE DATA. EasyShip's API needs a bearer token
 * (EASYSHIP_API_TOKEN) which we don't have yet, so the request/response mapping
 * below follows their v2 shipments API by documentation only. The CSV path in
 * `parseEasyshipCsv` is the verified route: export shipments from the EasyShip
 * dashboard and import them — it produces the same charge rows.
 *
 * When a token is added, run `healthCheck()` first: it will confirm the field
 * names before any sync writes cost data.
 */
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import type { ItemisedLine } from "../../lib/shipping/match";

const API_BASE = "https://public-api.easyship.com/2023-01";

export class EasyshipConfigError extends Error {}

function token(): string {
  const t = env.EASYSHIP_API_TOKEN;
  if (!t) throw new EasyshipConfigError("EASYSHIP_API_TOKEN is not set");
  return t;
}

export function easyshipConfigured(): boolean {
  return Boolean(env.EASYSHIP_API_TOKEN);
}

async function easyshipGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`EasyShip HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function healthCheck(): Promise<{ ok: boolean; detail?: string }> {
  if (!easyshipConfigured()) return { ok: false, detail: "EASYSHIP_API_TOKEN not set" };
  try {
    const body = await easyshipGet<Record<string, unknown>>("/shipments", { per_page: "1" });
    const keys = Object.keys(body).join(", ");
    return { ok: true, detail: `reachable; top-level keys: ${keys}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

interface EasyshipShipment {
  easyship_shipment_id?: string;
  platform_order_number?: string | null;
  trackings?: Array<{ tracking_number?: string | null }> | null;
  tracking_number?: string | null;
  shipping_documents?: unknown;
  created_at?: string | null;
  rates?: unknown;
  /** Costs — names vary by API version; read defensively. */
  total_charge?: number | string | null;
  shipment_charge_total?: number | string | null;
  shipment_charge?: number | string | null;
  import_tax_charge?: number | string | null;
  import_duty_charge?: number | string | null;
  ddp_handling_fee?: number | string | null;
  insurance_fee?: number | string | null;
  fuel_surcharge?: number | string | null;
  currency?: string | null;
}

const toCents = (v: number | string | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** Map an EasyShip shipment to an itemised charge line. */
export function mapShipmentToLine(s: EasyshipShipment): ItemisedLine {
  const tracking = s.trackings?.[0]?.tracking_number ?? s.tracking_number ?? null;
  const ship = toCents(s.shipment_charge ?? s.shipment_charge_total ?? s.total_charge);
  const duties = toCents(s.import_tax_charge) + toCents(s.import_duty_charge) + toCents(s.ddp_handling_fee);
  const surcharge = toCents(s.insurance_fee) + toCents(s.fuel_surcharge);
  return {
    trackingNumber: tracking,
    orderNumber: s.platform_order_number ?? null,
    shippedOn: s.created_at ? s.created_at.slice(0, 10) : null,
    shipCents: ship,
    dutiesCents: duties,
    surchargeCents: surcharge,
    note: s.easyship_shipment_id ? `easyship:${s.easyship_shipment_id}` : null,
  };
}

/** Fetch shipments in a date window and map them to charge lines. */
export async function fetchShipmentLines(since: string, until: string): Promise<ItemisedLine[]> {
  const out: ItemisedLine[] = [];
  let page = 1;
  for (;;) {
    const body = await easyshipGet<{ shipments?: EasyshipShipment[]; meta?: { pagination?: { page?: number; total_pages?: number } } }>(
      "/shipments",
      { per_page: "100", page: String(page), created_at_from: since, created_at_to: until },
    );
    const batch = body.shipments ?? [];
    for (const s of batch) out.push(mapShipmentToLine(s));

    const pg = body.meta?.pagination;
    if (!pg?.total_pages || page >= pg.total_pages || batch.length === 0) break;
    page++;
    if (page > 200) {
      logger.warn("EasyShip pagination cap hit at 200 pages");
      break;
    }
  }
  return out;
}

/**
 * Parse an EasyShip CSV export into charge lines. This is the path that works
 * today, no token required. Header names are matched loosely because EasyShip's
 * export columns differ per account configuration; anything unmatched is 0 rather
 * than a wrong guess.
 */
export function parseEasyshipCsv(content: string): ItemisedLine[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const find = (...candidates: string[]): number => {
    for (const c of candidates) {
      const i = header.findIndex((h) => h === c);
      if (i >= 0) return i;
    }
    for (const c of candidates) {
      const i = header.findIndex((h) => h.includes(c));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iTracking = find("tracking number", "tracking_number", "tracking");
  const iOrder = find("platform order number", "order number", "order_number", "order");
  const iDate = find("created at", "created_at", "ship date", "date");
  const iShip = find("shipment charge", "shipping cost", "freight", "total charge");
  const iTax = find("import tax charge", "import tax", "tax charge");
  const iDuty = find("import duty charge", "import duty", "duty");
  const iDdp = find("ddp handling fee", "handling fee");
  const iIns = find("insurance fee", "insurance");
  const iFuel = find("fuel surcharge", "fuel");

  const cell = (cells: string[], i: number): string =>
    i >= 0 ? (cells[i] ?? "").trim().replace(/^"|"$/g, "") : "";

  const out: ItemisedLine[] = [];
  for (let n = 1; n < lines.length; n++) {
    const cells = lines[n].split(",");
    const tracking = cell(cells, iTracking) || null;
    const orderNumber = cell(cells, iOrder) || null;
    if (!tracking && !orderNumber) continue;

    const duties =
      toCents(cell(cells, iTax)) + toCents(cell(cells, iDuty)) + toCents(cell(cells, iDdp));
    const surcharge = toCents(cell(cells, iIns)) + toCents(cell(cells, iFuel));
    const rawDate = cell(cells, iDate);

    out.push({
      trackingNumber: tracking,
      orderNumber,
      shippedOn: /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : null,
      shipCents: toCents(cell(cells, iShip)),
      dutiesCents: duties,
      surchargeCents: surcharge,
      note: "easyship csv",
    });
  }
  return out;
}

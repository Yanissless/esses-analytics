/**
 * Parse Shopify's "Shipping labels by order" report.
 *
 * This is the best shipping-cost source available: Shopify's Admin API exposes no
 * label price, but this report gives the ACTUAL cost per label, keyed by order
 * name — so charges attach exactly rather than being allocated.
 *
 * Columns (as exported):
 *   Month, Order name, Origin country, Destination country,
 *   Shipping carrier, Shipping service, Shipping label costs
 *
 * An order with several labels appears as several rows; each becomes its own
 * charge row and they sum per order.
 */
import { parse } from "csv-parse/sync";
import type { ItemisedLine } from "../../lib/shipping/match";

export interface ShippingReportRow {
  month: string | null;
  orderName: string;
  originCountry: string | null;
  destinationCountry: string | null;
  carrier: string | null;
  service: string | null;
  costCents: number;
}

function toCents(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function parseShippingLabelReport(content: string): ShippingReportRow[] {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;

  const pick = (r: Record<string, string>, ...names: string[]): string => {
    for (const n of names) {
      // Exact, then case-insensitive contains.
      if (r[n] != null) return r[n];
      const key = Object.keys(r).find((k) => k.toLowerCase() === n.toLowerCase());
      if (key) return r[key];
    }
    for (const n of names) {
      const key = Object.keys(r).find((k) => k.toLowerCase().includes(n.toLowerCase()));
      if (key) return r[key];
    }
    return "";
  };

  const out: ShippingReportRow[] = [];
  for (const r of records) {
    const orderName = pick(r, "Order name", "order").trim();
    if (!orderName) continue;
    out.push({
      month: pick(r, "Month").trim() || null,
      orderName: orderName.startsWith("#") ? orderName : `#${orderName}`,
      originCountry: pick(r, "Origin country").trim() || null,
      destinationCountry: pick(r, "Destination country").trim() || null,
      carrier: pick(r, "Shipping carrier", "carrier").trim() || null,
      service: pick(r, "Shipping service", "service").trim() || null,
      costCents: toCents(pick(r, "Shipping label costs", "label cost", "cost")),
    });
  }
  return out;
}

/** Convert report rows to itemised charge lines (matched by order name). */
export function reportRowsToLines(rows: ShippingReportRow[]): ItemisedLine[] {
  return rows.map((r) => ({
    trackingNumber: null, // the report carries no tracking number
    orderNumber: r.orderName,
    shippedOn: r.month, // month granularity is all the report gives
    shipCents: r.costCents,
    dutiesCents: 0,
    surchargeCents: 0,
    note: [r.carrier, r.service].filter(Boolean).join(" · ") || null,
  }));
}

export interface DerivedRate {
  carrier: string;
  scope: "domestic" | "international";
  avgCents: number;
  medianCents: number;
  shipments: number;
}

/**
 * Average/median actual label cost per carrier, split domestic vs international.
 *
 * Used to refresh `shipping_rate_rules` from reality so shipments the report
 * doesn't cover still get a credible estimate. Median is reported alongside the
 * mean because a few express labels skew the average badly.
 */
export function deriveRates(
  rows: ShippingReportRow[],
  domesticCountry = "United States",
): DerivedRate[] {
  const groups = new Map<string, number[]>();

  for (const r of rows) {
    if (!r.carrier || r.costCents <= 0) continue;
    const scope = r.destinationCountry === domesticCountry ? "domestic" : "international";
    const key = `${r.carrier}|${scope}`;
    const list = groups.get(key) ?? [];
    list.push(r.costCents);
    groups.set(key, list);
  }

  const out: DerivedRate[] = [];
  for (const [key, costs] of groups) {
    const [carrier, scope] = key.split("|") as [string, "domestic" | "international"];
    costs.sort((a, b) => a - b);
    const sum = costs.reduce((s, c) => s + c, 0);
    const mid = Math.floor(costs.length / 2);
    const median =
      costs.length % 2 === 0 ? Math.round((costs[mid - 1] + costs[mid]) / 2) : costs[mid];
    out.push({
      carrier,
      scope,
      avgCents: Math.round(sum / costs.length),
      medianCents: median,
      shipments: costs.length,
    });
  }
  return out.sort((a, b) => b.shipments - a.shipments);
}

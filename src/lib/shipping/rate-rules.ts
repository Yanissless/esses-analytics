/**
 * The ONE definition of how a shipment matches a `shipping_rate_rules` row.
 *
 * This predicate used to be copy-pasted at five call sites, and they had silently
 * drifted apart:
 *
 *  - `metrics/order-profit.ts` and `metrics/rollup.ts` ignored `service_pattern`, so a
 *    service-specific rule would be honoured by the International page but not by the
 *    materialised `order_profit` the Profit page reads.
 *  - Both call sites in `lib/shipping/match.ts` ignored `zone`, so the seeded
 *    "International (any carrier)" rule — scoped to `zone = 'row'` — could match a US
 *    shipment during batch allocation and price it at the international rate.
 *
 * Neither had bitten yet only because no rule currently sets `service_pattern`. That's
 * luck, not safety: the shipping-report sync writes rules automatically, and the same
 * class of duplication already produced two live bugs on this project (the
 * `revenue_class` CASE, and the country-scoping of derived international rules).
 *
 * Change the matching logic here and every surface moves together.
 */
import { sql, type SQL } from "drizzle-orm";

export interface RateRuleMatchOptions {
  /**
   * Alias of a row exposing `tracking_company`, `service_name` and `shipped_at` —
   * in practice always a `fulfillments` row.
   */
  fulfilment: string;
  /** Expression yielding the destination country (ISO alpha-2), may be NULL. */
  country: SQL;
  /**
   * Expression yielding the shipping zone. Required: omitting it is what let
   * zone-scoped rules leak across zones in `match.ts`. Pass a scalar subquery
   * against `market_config` when the query has no zone column of its own.
   */
  zone: SQL;
  /** Date the rule must already be effective on. */
  effectiveOn: SQL;
}

/**
 * The WHERE body selecting rules that apply to a shipment, for a `shipping_rate_rules`
 * row aliased `rr`.
 *
 * Every clause is "NULL means any", so an unscoped rule is a catch-all and a scoped
 * one only fires where it belongs. `exclude_country_code` is the inverse — it names a
 * country the rule must NOT apply to, which is how "international" rules avoid
 * matching domestic shipments (see the derived-rules note in shipping-costs.ts).
 */
export function rateRuleMatchWhere(opts: RateRuleMatchOptions): SQL {
  const f = sql.raw(opts.fulfilment);
  return sql`
    (rr.carrier_pattern IS NULL
      OR lower(coalesce(${f}.tracking_company, '')) LIKE '%' || lower(rr.carrier_pattern) || '%')
    AND (rr.service_pattern IS NULL
      OR lower(coalesce(${f}.service_name, '')) LIKE '%' || lower(rr.service_pattern) || '%')
    AND (rr.country_code IS NULL OR rr.country_code = ${opts.country})
    -- COALESCE so an order with no country still matches an 'exclude US' rule rather
    -- than falling through: unknown destination is treated as international.
    AND (rr.exclude_country_code IS NULL
      OR rr.exclude_country_code <> COALESCE(${opts.country}, ''))
    AND (rr.zone IS NULL OR rr.zone = ${opts.zone})
    AND rr.effective_date <= ${opts.effectiveOn}
  `;
}

/** Most specific rule wins, newest first as the tiebreak. */
export const RATE_RULE_ORDER = sql`ORDER BY rr.priority DESC, rr.effective_date DESC`;

/**
 * Scalar subquery giving the expected label cost for one shipment, or NULL when no
 * rule matches. Drop-in replacement for the hand-written subqueries this replaces.
 */
export function expectedRateCentsSql(opts: RateRuleMatchOptions): SQL {
  return sql`(
    SELECT rr.expected_cost_amount
      FROM shipping_rate_rules rr
     WHERE ${rateRuleMatchWhere(opts)}
     ${RATE_RULE_ORDER}
     LIMIT 1
  )`;
}

/**
 * Zone for a shipment when the surrounding query has no zone of its own, resolved
 * from `market_config` by destination country. Returns NULL for an unmapped country,
 * which correctly prevents zone-scoped rules from matching it.
 */
export function zoneFromCountrySql(country: SQL): SQL {
  return sql`(
    SELECT mc.shipping_zone FROM market_config mc
     WHERE mc.country_code = ${country}
     LIMIT 1
  )`;
}

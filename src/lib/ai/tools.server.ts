/**
 * The analyst's tools: read-only wrappers over `src/metrics/*`, gated by capability.
 *
 * ## The security model, and why it is belt and braces
 *
 * Rule 7 says guard on a capability, never a role comparison, because a page that gets
 * missed leaks financial or customer data rather than merely miscalculating. An agent
 * makes that worse in a specific way: it is a single endpoint that can reach every
 * metric in the app, and its behaviour is decided by a model reading text that includes
 * the user's own words. So there are two independent gates, and neither trusts the model:
 *
 *  1. **The toolset is built per request from the caller's role.** A marketing user's
 *     agent is never handed `margin_summary` — the tool is absent from the request, so
 *     the model cannot call it, cannot be argued into calling it, and cannot infer what
 *     it would have returned. This is the gate that matters.
 *
 *  2. **Every handler re-checks its capability before touching the database.** Redundant
 *     while gate 1 holds — which is the point. It is what keeps a future edit that adds a
 *     tool to the wrong capability group, or a refactor that mixes up the filter, from
 *     turning into a silent data leak. The check is three lines; the failure it prevents
 *     is the worst kind this app has.
 *
 * Both gates read `ANALYST_TOOLS` and `can()` — the same definitions the pages and the
 * nav use. Adding a tool means adding one entry to that map, exactly as adding a page
 * means adding one capability.
 *
 * ## No writes, by construction
 *
 * There is no tool here that writes. Not "no tool that the prompt discourages using" —
 * no such tool exists to call. Costs, the margin boundary, goals and people are changed
 * through their own pages, by a user with `settings` or `team`, with the audit trail
 * those pages carry.
 */

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

// Relative imports throughout: the `@/*` alias is Next-only. See the note in analyst.ts.
import type { Role } from "../auth/capabilities";
import { ANALYST_TOOLS, roleCanUseTool } from "./analyst";

import {
  getDataQuality,
  getMonthlyRevenue,
  getOrderMix,
  getRevenueSummary,
  getSubscriptionHealth,
  getTopCustomers,
} from "../../metrics/overview";
import { getPeriodMetrics } from "../../metrics/rollup";
import { getGoalProgress, getLastMetricsDate } from "../../metrics/forecast.server";
import { getSocialSummary } from "../../metrics/social";
import { getSocialInsights } from "../../metrics/social-insights";
import { getAudienceGrowth } from "../../metrics/audience-growth";
import {
  getCohorts,
  getLtvByChannel,
  getLtvSummary,
  getRetentionCurve,
  getSubscriptionRetention,
} from "../../metrics/ltv";
import { getChurnCohorts, getRenewalCycleChurn, type ChurnDimension } from "../../metrics/churn";
import { getGeoConcentration, getPersonaProfiles } from "../../metrics/personas";
import { getMarginSummary, getMarketMargins } from "../../metrics/cogs";
import { getProductProfit, getProfitQuality, getProfitWaterfall } from "../../metrics/profit";
import { getCogsCoverageSummary } from "../../metrics/cogs-scenario";
import { BOUNDARY_META } from "../../metrics/margin-boundary";
import { getMarginBoundary } from "../../metrics/margin-boundary.server";

/** Thrown when gate 2 fires. Gate 1 means it should be unreachable. */
export class CapabilityError extends Error {
  constructor(tool: string, role: Role) {
    super(
      `Tool ${tool} requires the ${ANALYST_TOOLS[tool]?.capability ?? "(unregistered)"} ` +
        `capability, which the ${role} role does not have`,
    );
    this.name = "CapabilityError";
  }
}

function assertCapability(role: Role, tool: string): void {
  if (!roleCanUseTool(role, tool)) throw new CapabilityError(tool, role);
}

/** Tool results go back as JSON. Nulls survive, which rule 3 depends on. */
function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === undefined ? null : v));
}

/**
 * Resolves the default date window once per request.
 *
 * Every date-ranged tool defaults to the full span of loaded data, matching what the
 * pages do. Memoised because a single question can call four ranged tools and there is
 * no reason to ask the database for the same two dates four times.
 */
function makeWindow() {
  let cached: { since: string; until: string } | null = null;
  return async function resolve(since?: string, until?: string) {
    if (since && until) return { since, until };
    if (!cached) {
      const summary = await getRevenueSummary();
      cached = {
        since: summary.firstOrderDate ?? "2025-10-01",
        until: summary.lastOrderDate ?? new Date().toISOString().slice(0, 10),
      };
    }
    return { since: since ?? cached.since, until: until ?? cached.until };
  };
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

const DATE_RANGE = {
  type: "object",
  properties: {
    since: { type: "string", description: "Start date, YYYY-MM-DD. Omit for all loaded data." },
    until: { type: "string", description: "End date, YYYY-MM-DD. Omit for all loaded data." },
  },
  additionalProperties: false,
} as const;

/**
 * Builds the toolset this role is allowed to use.
 *
 * The returned array is what gets sent to the API, so filtering here *is* the access
 * control — see gate 1 in the module note above.
 */
export function buildAnalystTools(role: Role): BetaRunnableTool[] {
  const window = makeWindow();

  /** Boundary metadata rides along with every margin figure, per rule 8. */
  async function withBoundary<T>(load: (b: Awaited<ReturnType<typeof getMarginBoundary>>) => Promise<T>) {
    const boundary = await getMarginBoundary();
    const meta = BOUNDARY_META[boundary];
    return {
      boundary: { id: meta.id, label: meta.label, meaning: meta.short },
      caveat:
        "Margin depends on this boundary. Name it when quoting any figure below, per rule 8. " +
        "Print COGS is an unverified placeholder, so COGS-derived figures inherit that uncertainty.",
      data: await load(boundary),
    };
  }

  const all: Record<string, BetaRunnableTool> = {
    // ---- Coverage: available to every role ------------------------------
    data_coverage: betaTool({
      name: "data_coverage",
      description:
        "How much of the data can be trusted: ingest coverage, missing fields, how fresh " +
        "the materialised metrics are, and which sources last synced. Call this before " +
        "leaning on any Meta ad figure, and whenever the answer depends on completeness.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "data_coverage");
        const [quality, lastMetrics] = await Promise.all([getDataQuality(), getLastMetricsDate()]);
        return json({
          quality,
          metricsRebuiltThrough: lastMetrics,
          caveat:
            "Meta ad conversions were stale and roughly 3x inflated at last sync (overlapping " +
            "purchase action types). Treat Meta-reported conversion counts as unreliable until " +
            "a re-sync. Shipping costs fall back to rate-rule estimates where labels are missing.",
        });
      },
    }),

    // ---- revenue -------------------------------------------------------
    revenue_summary: betaTool({
      name: "revenue_summary",
      description:
        "Headline revenue: Shopify gross/refunds/net, Stripe paid, combined net, order and " +
        "customer counts, AOV, and the first/last order dates. AOV already divides by paid " +
        "orders only. Start here for 'how are we doing' questions.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "revenue_summary");
        return json(await getRevenueSummary());
      },
    }),

    monthly_revenue: betaTool({
      name: "monthly_revenue",
      description: "Revenue by calendar month, for trend and seasonality questions.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "monthly_revenue");
        return json(await getMonthlyRevenue());
      },
    }),

    order_mix: betaTool({
      name: "order_mix",
      description:
        "Order counts and revenue split by revenue class (paid, prepaid_delivery, comp). " +
        "Use this to explain why a raw order count and a revenue figure disagree.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "order_mix");
        return json(await getOrderMix());
      },
    }),

    subscription_health: betaTool({
      name: "subscription_health",
      description:
        "Active subscription counts and MRR. MRR follows the DELIVERY cadence — churn does " +
        "not; use the churn tools for renewal questions.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "subscription_health");
        return json(await getSubscriptionHealth());
      },
    }),

    period_metrics: betaTool({
      name: "period_metrics",
      description:
        "Blended metrics for a date range from the materialised daily table: revenue, ad " +
        "spend, MER, aMER, CAC, CM1-CM3 and order counts. Ratios are null when not " +
        "measurable. Best single tool for 'how did period X do'.",
      inputSchema: DATE_RANGE,
      run: async (args: { since?: string; until?: string }) => {
        assertCapability(role, "period_metrics");
        const { since, until } = await window(args.since, args.until);
        return json({ since, until, metrics: await getPeriodMetrics(since, until) });
      },
    }),

    goal_progress: betaTool({
      name: "goal_progress",
      description:
        "Progress against the configured goals for a month, with a projection and pace. " +
        "Defaults to the month of the last synced day, because projecting past the last " +
        "synced date treats missing days as zeros and tanks the estimate.",
      inputSchema: {
        type: "object",
        properties: {
          periodStart: { type: "string", description: "First day of the month, YYYY-MM-DD." },
        },
        additionalProperties: false,
      } as const,
      run: async (args: { periodStart?: string }) => {
        assertCapability(role, "goal_progress");
        const asOf = (await getLastMetricsDate()) ?? new Date().toISOString().slice(0, 10);
        const periodStart = args.periodStart ?? `${asOf.slice(0, 7)}-01`;
        return json({ periodStart, asOf, goals: await getGoalProgress(periodStart, asOf) });
      },
    }),

    // ---- marketing -----------------------------------------------------
    social_summary: betaTool({
      name: "social_summary",
      description:
        "Social performance for a range: touchpoints, social-touched orders and revenue, " +
        "paid spend, paid ROAS, and — importantly — attribution coverage, i.e. how much of " +
        "all revenue attribution can speak to at all. Always report that coverage.",
      inputSchema: DATE_RANGE,
      run: async (args: { since?: string; until?: string }) => {
        assertCapability(role, "social_summary");
        const { since, until } = await window(args.since, args.until);
        return json({
          since,
          until,
          summary: await getSocialSummary(since, until),
          caveat:
            "Attributed ROAS is a band rather than a point estimate until UTM tagging is " +
            "rolled out. Quote the range and the coverage figure.",
        });
      },
    }),

    channel_ltv: betaTool({
      name: "channel_ltv",
      description:
        "Lifetime value and retention by stamped acquisition channel — aggregate, no " +
        "individual records. The tool for 'which channel brings better customers'.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "channel_ltv");
        return json(await getLtvByChannel());
      },
    }),

    // ---- audience ------------------------------------------------------
    cohorts: betaTool({
      name: "cohorts",
      description: "Customer cohorts by first-order month: size, revenue and repeat behaviour.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "cohorts");
        return json(await getCohorts());
      },
    }),

    ltv_summary: betaTool({
      name: "ltv_summary",
      description: "Unified LTV across Shopify and Stripe: historical, 12-month and predictive.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "ltv_summary");
        return json(await getLtvSummary());
      },
    }),

    churn_cohorts: betaTool({
      name: "churn_cohorts",
      description:
        "Churn and retention per cohort on one dimension. Prefer acquisition_type first: " +
        "free signups, migrated legacy subscribers and organic payers are different " +
        "populations, and blending them poisons every other cut. Pass planName or " +
        "cycleMonths when the dimension correlates with time (issue, signup_month), " +
        "because a renewal is 3 months on one plan and 12 on another.",
      inputSchema: {
        type: "object",
        properties: {
          dimension: {
            type: "string",
            enum: [
              "issue_at_signup",
              "issue_purchased",
              "promo",
              "plan",
              "signup_month",
              "channel",
              "acquisition_type",
            ],
            description: "Which cohort dimension to cut by.",
          },
          source: { type: "string", enum: ["skio", "stripe", "all"] },
          minSubscriptions: {
            type: "number",
            description: "Drop cohorts smaller than this. Thin cohorts mislead; 20 is sensible.",
          },
          planName: { type: "string", description: "Hold plan constant." },
          cycleMonths: { type: "number", description: "Hold billing cadence constant." },
        },
        required: ["dimension"],
        additionalProperties: false,
      } as const,
      run: async (args: {
        dimension: string;
        source?: "skio" | "stripe" | "all";
        minSubscriptions?: number;
        planName?: string;
        cycleMonths?: number;
      }) => {
        assertCapability(role, "churn_cohorts");
        const cohorts = await getChurnCohorts(args.dimension as ChurnDimension, {
          source: args.source,
          minSubscriptions: args.minSubscriptions,
          planName: args.planName,
          cycleMonths: args.cycleMonths,
        });
        return json({
          dimension: args.dimension,
          held: { planName: args.planName ?? null, cycleMonths: args.cycleMonths ?? null },
          cohorts,
          caveat:
            "Subscriptions imported during the October 2025 migration carry the import date " +
            "as started_at, not a real signup date — tenure computed from it is suspect.",
        });
      },
    }),

    renewal_churn: betaTool({
      name: "renewal_churn",
      description:
        "Churn at each renewal using each subscription's own billing cadence — the " +
        "cadence-correct alternative to a monthly survival curve, which shows a false " +
        "cliff at months 3-4 because only the quarterly plan rebills then. Pass planName " +
        "or cycleMonths unless comparing cadences is the actual point.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["skio", "stripe", "all"] },
          maxCycles: { type: "number" },
          planName: { type: "string" },
          cycleMonths: { type: "number" },
        },
        additionalProperties: false,
      } as const,
      run: async (args: {
        source?: "skio" | "stripe" | "all";
        maxCycles?: number;
        planName?: string;
        cycleMonths?: number;
      }) => {
        assertCapability(role, "renewal_churn");
        return json({
          held: { planName: args.planName ?? null, cycleMonths: args.cycleMonths ?? null },
          cycles: await getRenewalCycleChurn(args),
          caveat:
            "churnRateAtCyclePct is CONDITIONAL — the share of those who reached the previous " +
            "renewal who failed to reach this one, not cumulative loss. A large share of " +
            "subscriptions have never faced a renewal at all, so do not present a base-wide rate.",
        });
      },
    }),

    retention_curve: betaTool({
      name: "retention_curve",
      description:
        "Month-by-month retention curve. Read the cadence warning: a dip here can be one " +
        "plan's rebill rather than a universal cliff. Prefer renewal_churn for renewal risk.",
      inputSchema: {
        type: "object",
        properties: { maxMonths: { type: "number" } },
        additionalProperties: false,
      } as const,
      run: async (args: { maxMonths?: number }) => {
        assertCapability(role, "retention_curve");
        return json({
          curve: await getRetentionCurve(args.maxMonths ?? 12),
          caveat:
            "Blended across plans, so a drop at months 3-4 reflects the quarterly plan's " +
            "rebill and is not a renewal point for the annual plan at all.",
        });
      },
    }),

    subscription_retention: betaTool({
      name: "subscription_retention",
      description: "Retention by plan, holding cadence constant within each plan.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "subscription_retention");
        return json(await getSubscriptionRetention());
      },
    }),

    personas: betaTool({
      name: "personas",
      description:
        "Behavioural segments with sizes and Meta audience thresholds. Counts only — this " +
        "deliberately returns no contact lists, so it cannot be used to build one.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "personas");
        return json(await getPersonaProfiles());
      },
    }),

    geo_concentration: betaTool({
      name: "geo_concentration",
      description: "Where customers are concentrated geographically, aggregate counts only.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      } as const,
      run: async (args: { limit?: number }) => {
        assertCapability(role, "geo_concentration");
        return json(await getGeoConcentration(args.limit ?? 12));
      },
    }),

    /**
     * Reach is the one figure in the whole toolset that must not be summed, so this returns
     * the pre-computed aggregates and drops the daily series. Handing the model 30 daily
     * numbers plus a note saying "don't add these up" invites exactly that; handing it
     * `reachDailyAvg` and an upper bound named as one does not.
     */
    social_insights: betaTool({
      name: "social_insights",
      description:
        "Instagram organic reach and engagement for a date range: average DAILY unique reach, " +
        "peak and trough days, views, profile views, interactions, and rates against accounts " +
        "reached. There is deliberately no total reach for the range — reach counts distinct " +
        "accounts and cannot be summed; summedReachUpperBound is an upper bound only and runs " +
        "roughly 50% above the truth for this account. Quote the per-day average. Rates are " +
        "against accounts reached, never followers, because reach exceeds the follower count.",
      // DATE_RANGE + window(): optional dates defaulting to the loaded span, same as every
      // other ranged tool. Required dates would force the model to invent them, and made
      // `check:analyst` — which calls every tool with no args — fail on this one alone.
      inputSchema: DATE_RANGE,
      run: async (args: { since?: string; until?: string }) => {
        assertCapability(role, "social_insights");
        const { since, until } = await window(args.since, args.until);
        const { points, ...rest } = await getSocialInsights("instagram", since, until);
        return json({ ...rest, daysReturned: points.length });
      },
    }),

    audience_growth: betaTool({
      name: "audience_growth",
      description:
        "Instagram followers against active subscribers over time: both totals, growth rates, " +
        "the ratio, and the correlation of their CHANGES. Use deltaCorrelation, never " +
        "levelCorrelation — both series trend upward, so a correlation on levels sits near 1.0 " +
        "whether or not any relationship exists and really measures the passage of time. " +
        "lag.best is the strongest POSITIVE lag; lag.strongestInverse is reported separately " +
        "and is NOT evidence that followers lead. Read caveats before quoting: days before " +
        "13 Aug 2026 are reconstructed from deltas rather than observed.",
      inputSchema: {
        type: "object",
        properties: { grain: { type: "string", enum: ["day", "week"] } },
        additionalProperties: false,
      } as const,
      run: async (args: { grain?: "day" | "week" }) => {
        assertCapability(role, "audience_growth");
        const { points, indexed, ...rest } = await getAudienceGrowth(
          "instagram",
          args.grain ?? "week",
        );
        return json({ ...rest, pointsReturned: points.length, indexedReturned: indexed.length });
      },
    }),

    // ---- margin --------------------------------------------------------
    margin_summary: betaTool({
      name: "margin_summary",
      description:
        "Trading margin on the active boundary: net ex-VAT, COGS, CM1, CM2, units, uncosted " +
        "units, the shipping gap, and the comp programme reported separately. Returns the " +
        "boundary — name it when quoting anything from here.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "margin_summary");
        return json(await withBoundary((b) => getMarginSummary(b)));
      },
    }),

    profit_waterfall: betaTool({
      name: "profit_waterfall",
      description:
        "Revenue-to-CM3 waterfall for a range on the active boundary, step by step, with " +
        "comps and ad spend broken out. Returns the boundary — name it.",
      inputSchema: DATE_RANGE,
      run: async (args: { since?: string; until?: string }) => {
        assertCapability(role, "profit_waterfall");
        const { since, until } = await window(args.since, args.until);
        return json({ since, until, ...(await withBoundary((b) => getProfitWaterfall(since, until, b))) });
      },
    }),

    market_margins: betaTool({
      name: "market_margins",
      description:
        "Margin by shipping market on the active boundary, with comps always in their own " +
        "column so a market is never judged on copies it gave away. Returns the boundary.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "market_margins");
        return json(await withBoundary((b) => getMarketMargins(b)));
      },
    }),

    product_profit: betaTool({
      name: "product_profit",
      description: "Margin by product for a range on the active boundary. Returns the boundary.",
      inputSchema: DATE_RANGE,
      run: async (args: { since?: string; until?: string }) => {
        assertCapability(role, "product_profit");
        const { since, until } = await window(args.since, args.until);
        return json({ since, until, ...(await withBoundary((b) => getProductProfit(since, until, b))) });
      },
    }),

    profit_quality: betaTool({
      name: "profit_quality",
      description:
        "How trustworthy the profit figures are for a range: how many orders have real " +
        "shipping costs versus rate-rule or zone estimates, and how many units are uncosted. " +
        "Call this before presenting a confident margin number.",
      inputSchema: DATE_RANGE,
      run: async (args: { since?: string; until?: string }) => {
        assertCapability(role, "profit_quality");
        const { since, until } = await window(args.since, args.until);
        return json({ since, until, quality: await getProfitQuality(since, until) });
      },
    }),

    cogs_coverage: betaTool({
      name: "cogs_coverage",
      description:
        "How much of sold volume has a real cost attached versus falling back to the " +
        "placeholder per-copy print cost. The honest bound on every margin figure.",
      inputSchema: NO_ARGS,
      run: async () => {
        assertCapability(role, "cogs_coverage");
        return json(await getCogsCoverageSummary());
      },
    }),

    // ---- customers -----------------------------------------------------
    top_customers: betaTool({
      name: "top_customers",
      description:
        "Highest-value individual customers, including names and emails. Personal data — " +
        "only summarise what the question actually needs.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      } as const,
      run: async (args: { limit?: number }) => {
        assertCapability(role, "top_customers");
        return json(await getTopCustomers(Math.min(args.limit ?? 10, 50)));
      },
    }),
  };

  // Registry drift is a loud failure, not a silent one. A tool implemented without an
  // entry in ANALYST_TOOLS has no capability attached, so `roleCanUseTool` would fail it
  // closed and it would simply never run — a confusing bug. An entry with no
  // implementation makes the UI advertise a tool that doesn't exist. Both are edits a
  // future session could plausibly make; neither should be discovered in production.
  const implemented = Object.keys(all).sort();
  const registered = Object.keys(ANALYST_TOOLS).sort();
  if (implemented.join() !== registered.join()) {
    const missing = registered.filter((n) => !implemented.includes(n));
    const extra = implemented.filter((n) => !registered.includes(n));
    throw new Error(
      "Analyst tool registry and implementations disagree. " +
        `Registered but not implemented: [${missing.join(", ") || "none"}]. ` +
        `Implemented but not registered: [${extra.join(", ") || "none"}]. ` +
        "Every tool needs an entry in ANALYST_TOOLS (lib/ai/analyst.ts) carrying the " +
        "capability that gates it.",
    );
  }

  // Gate 1: the caller's role decides which tools exist in the request at all.
  return Object.entries(all)
    .filter(([name]) => roleCanUseTool(role, name))
    .map(([, tool]) => tool);
}

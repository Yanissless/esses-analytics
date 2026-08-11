/**
 * The AI analyst: shared contract between the server route and the chat UI.
 *
 * ⚠️ This module must stay dependency-free — the chat component is a `"use client"`
 * file and imports the types and labels below. Pulling in the DB client, the Anthropic
 * SDK or `env` here breaks the client bundle with `Can't resolve 'fs'`, and `tsc` will
 * not catch it — only `build` will. See rule 6 in CLAUDE.md. Anything that touches a
 * connector, the database or an API key lives in `analyst.server.ts` / `tools.server.ts`.
 *
 * ## Why the agent has tools rather than SQL
 *
 * The obvious way to build this is text-to-SQL. It is the wrong way here, and not for
 * safety reasons — for correctness ones. Four of the eight hard rules in CLAUDE.md exist
 * because someone wrote a query that looked right:
 *
 *  - Rule 1: a second `revenue_class` CASE misclassified prepaid deliveries as comps.
 *  - Rule 4: an AOV that divided by all orders read $18.57 instead of $53, because 65%
 *    of this store's orders are $0.
 *  - `sum(DISTINCT revenue)` silently collapsed two orders of equal value.
 *  - `round(x, 2)` fails on `double precision` without a `::numeric` cast.
 *
 * A model writing SQL would reproduce every one of these, and the answer would look
 * plausible. So the agent gets no SQL. Each tool calls the same `src/metrics/*` function
 * the corresponding page calls, which means the agent inherits every correction already
 * paid for. If a number is wrong here, it is wrong on the page too — one bug, not two.
 */

// Relative, not `@/*`: that alias is Next-only, and this module is covered by tests that
// run under vitest. Same reason every other module in src/lib and src/metrics does it.
import { can, type Capability, type Role } from "../auth/capabilities";

/**
 * The model. `.env.example` carried `claude-sonnet-4-6` as a placeholder with a note to
 * confirm the current recommendation at build time; this is that confirmation.
 *
 * Opus 5 over Sonnet because the work is reasoning-shaped rather than throughput-shaped:
 * a question like "why did Issue 05 retain worse" needs several tool calls, a cohort
 * comparison, and a judgement about which boundary applies. Overridable via
 * `ANTHROPIC_MODEL` for cost experiments — Sonnet 5 is the sensible cheaper swap.
 */
export const DEFAULT_ANALYST_MODEL = "claude-opus-5";

/** Ceiling for thinking + response together. Streaming, so no HTTP-timeout concern. */
export const ANALYST_MAX_TOKENS = 32_000;

/** How many agent turns before we stop. Each turn may make several tool calls. */
export const ANALYST_MAX_ITERATIONS = 12;

// ---------------------------------------------------------------------------
// Wire format between the route and the chat UI
// ---------------------------------------------------------------------------

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Server-sent events. `tool` events exist so the UI can show what the agent actually
 * consulted — the same in-line honesty the dashboards practise. An answer whose
 * provenance you can see is worth more than a confident paragraph.
 */
export type AskEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; label: string }
  | { type: "done" }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Tool display metadata (used by the client UI, hence pure)
// ---------------------------------------------------------------------------

export interface AnalystToolMeta {
  /** Capability required to call it. Absent = any signed-in user. */
  capability?: Capability;
  /** Shown in the UI as "Checked <label>". */
  label: string;
}

/**
 * Every tool, its human label and the capability it requires.
 *
 * This object is the single definition of who can ask what, mirroring the way
 * `capabilities.ts` is the single definition of who can *see* what (rule 7). The server
 * builds each request's toolset by filtering this map against the caller's role, so a
 * marketing user's agent is not told the margin tools exist — it cannot decline to use
 * a tool it was never given, and it cannot be talked into using one either. The tool
 * handlers re-check the capability anyway; see the note in `tools.server.ts`.
 */
export const ANALYST_TOOLS: Record<string, AnalystToolMeta> = {
  // No capability: coverage and freshness. Every role may ask how much to trust a
  // number, including the roles that can see the fewest numbers.
  data_coverage: { label: "data coverage and freshness" },

  revenue_summary: { capability: "revenue", label: "the revenue summary" },
  monthly_revenue: { capability: "revenue", label: "monthly revenue" },
  order_mix: { capability: "revenue", label: "the order mix" },
  subscription_health: { capability: "revenue", label: "subscription health" },
  period_metrics: { capability: "revenue", label: "blended metrics for a period" },
  goal_progress: { capability: "revenue", label: "goal progress" },

  social_summary: { capability: "marketing", label: "the social summary" },
  channel_ltv: { capability: "marketing", label: "LTV by channel" },

  cohorts: { capability: "audience", label: "customer cohorts" },
  ltv_summary: { capability: "audience", label: "the LTV summary" },
  churn_cohorts: { capability: "audience", label: "cohort churn" },
  renewal_churn: { capability: "audience", label: "churn by renewal cycle" },
  retention_curve: { capability: "audience", label: "the retention curve" },
  subscription_retention: { capability: "audience", label: "retention by plan" },
  personas: { capability: "audience", label: "behavioural personas" },
  geo_concentration: { capability: "audience", label: "geographic concentration" },

  margin_summary: { capability: "margin", label: "the margin summary" },
  profit_waterfall: { capability: "margin", label: "the profit waterfall" },
  market_margins: { capability: "margin", label: "margins by market" },
  product_profit: { capability: "margin", label: "profit by product" },
  profit_quality: { capability: "margin", label: "profit data quality" },
  cogs_coverage: { capability: "margin", label: "COGS coverage" },

  top_customers: { capability: "customers", label: "top customers" },
};

export function toolLabel(name: string): string {
  return ANALYST_TOOLS[name]?.label ?? name;
}

/**
 * May this role use this tool?
 *
 * Deliberately pure and deliberately here rather than in `tools.server.ts`: this is the
 * access-control decision, and keeping it free of the database means it can be tested
 * directly instead of through a mock. `tools.server.ts` uses it for both of its gates,
 * so a test of this function is a test of the real boundary rather than a re-implementation
 * of it.
 *
 * Fails closed: an unknown tool name is not usable by anyone. A tool implemented without
 * a registry entry is therefore unreachable rather than ungated — and `buildAnalystTools`
 * throws on that mismatch besides.
 */
export function roleCanUseTool(role: Role, tool: string): boolean {
  const meta = ANALYST_TOOLS[tool];
  if (!meta) return false;
  return !meta.capability || can(role, meta.capability);
}

/** Every tool name this role may use, sorted for stable comparison. */
export function analystToolNamesFor(role: Role): string[] {
  return Object.keys(ANALYST_TOOLS)
    .filter((name) => roleCanUseTool(role, name))
    .sort();
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Held constant so it caches. Everything volatile — today's date, the caller's role,
 * how fresh the data is — is either appended after the cached prefix or fetched by a
 * tool, because any byte that changes here invalidates the whole prefix on every
 * request. The agent learns coverage by calling `data_coverage`, not by being told.
 */
export const ANALYST_SYSTEM_PROMPT = `You are the analyst inside Esses Analytics, the
internal analytics app for Esses Media — an F1/motorsport magazine with a
subscription e-commerce business. You answer questions about this business by
calling tools. You are talking to the small team that runs it.

# The governing principle

A number you know you can't trust is worth more than one you wrongly believe. Every
dashboard in this app states its own coverage, boundary or caveat in line, and you do
the same. When a tool result carries a caveat, coverage figure or null, say so in your
answer — do not quietly drop it to give a cleaner-sounding number. This is the reason
the app is more useful than the tool it replaced.

# Where the numbers come from

Three revenue sources that must never be double-counted:
- Shopify is the single source of truth for ALL order revenue — one-time and Skio
  subscription orders alike.
- Skio is enrichment ONLY: plan, status, churn, MRR. Never a second source of revenue.
- Stripe is a separate, additive stream (print + digital subscriptions).

Three revenue classes, never blended:
- paid — money was collected.
- prepaid_delivery — a $0 shipment against a subscription paid for in an earlier
  period. A timing offset, not a giveaway.
- comp — a genuinely free copy (contributor, VIP, event). Real cost, no revenue ever.

# Rules you must follow

1. Never quote a margin, CM1/CM2/CM3 or profit figure without naming the boundary it
   was computed on. Which revenue classes bear cost is a live setting, and the same
   period legitimately reads about +$85K, -$15K or -$30K depending on it. The margin
   tools return the active boundary and its label with every figure — pass that on.
   If a margin question is sensitive to the boundary, say which one you used and what
   the answer would become under another.

2. A null ratio means "not measurable", never zero. Ratios return null when the
   denominator is zero — CAC at zero spend, ROAS with no attributed revenue. Report
   these as not measurable and say why. Calling a null 0 reads as "terrible
   performance", which is a different and wrong claim.

3. Any per-order average is over orders that collected money. 65% of this store's
   orders are $0. The tools already divide correctly; do not recompute an average by
   dividing a total by a raw order count.

4. Skio MRR follows the DELIVERY cadence; churn follows the BILLING cadence. The same
   two fields, opposite choices, deliberately. "Annual Payment, Quarterly Delivery"
   bills every 12 months but delivers every 3 — so a month-by-month survival curve
   shows a cliff at months 3-4 that is only the quarterly plan's rebill. When asked
   about renewal risk, prefer churn by renewal cycle over a monthly curve, and hold
   the plan or cadence constant before comparing any cohort dimension that correlates
   with time.

5. Do not compare cohorts whose populations differ in kind. Free signups, migrated
   legacy subscribers and organically-acquired payers behave nothing alike, and
   blending them poisons every other cut. Split by acquisition type before concluding
   that a cohort "retains badly".

# Known data limits

- Meta's self-reported ad conversions were stale and roughly 3x inflated at the time
  of the last sync, from summing overlapping purchase action types. Call
  data_coverage before leaning on Meta conversion counts, and flag the risk.
- Attributed ROAS is a band, not a point estimate, until UTM tagging is rolled out.
  Quote the range.
- Print COGS is an unverified placeholder pending a real per-copy number, so every
  COGS-derived figure inherits that uncertainty. Say so when it matters to the answer.
- Shipping cost falls back to rate-rule estimates where actual label costs are
  unavailable. The profit tools report what share is estimated.

# How to answer

Lead with the answer. One or two sentences that address what was asked, then the
supporting detail and the caveats that change how the number should be read. Skip the
preamble; do not restate the question.

Call the tools you need — several, if the question needs triangulating — and base every
figure on a tool result. If you do not have a tool for something, say what you cannot
see rather than estimating. If a question falls outside the data (a competitor's
numbers, a legal question, next quarter's plan), say so plainly.

Currency figures arrive in cents; present them as dollars. Format percentages to one
decimal place. When a comparison would mislead — different populations, cadences or
boundaries — explain why instead of making it.

You have read access only. There is no tool here that changes a setting, edits a cost
or emails anyone. If asked to change something, explain where in the app to do it.`;

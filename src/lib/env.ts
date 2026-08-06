/**
 * Centralised, validated environment configuration.
 *
 * Import `env` from here in any SERVER/Node context (route handlers, server
 * actions, scripts, the DB client). It fails fast at first import if a required
 * variable is missing or malformed, so a misconfigured deploy never boots into
 * a half-broken state.
 *
 * IMPORTANT: do NOT import this module from Edge middleware. The Edge runtime
 * only inlines statically-referenced env vars, so `process.env` is not a full
 * object there and validation would spuriously fail. Middleware reads the one
 * secret it needs (AUTH_SECRET) directly — see src/lib/auth/session.ts.
 */
import { z } from "zod";

const envSchema = z.object({
  // ---- Runtime ---------------------------------------------------------
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  // ---- Core (required) -------------------------------------------------
  // Postgres connection string, e.g. postgres://user:pass@localhost:5432/esses_analytics
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Secret used to sign session cookies (jose HS256). Min 32 chars.
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters (use `openssl rand -base64 48`)"),

  // ---- Seed (used only by scripts/seed.ts) -----------------------------
  SEED_ADMIN_PASSWORD: z.string().optional(),

  /**
   * Shared secret guarding POST /api/sync, so a scheduler can trigger the incremental
   * sync without a user session. Optional here, but the route refuses EVERY request
   * when it's unset rather than running unauthenticated — a deployment that forgets it
   * fails closed. Min length matches AUTH_SECRET's reasoning: this endpoint can trigger
   * real third-party API spend.
   */
  CRON_SECRET: z.string().min(32).optional(),

  // ---- Connectors (optional in Phase 1; wired up in later phases) ------
  // Shopify Admin API.
  // SHOPIFY_SHOP must be the store's myshopifyDomain (e.g. 9fee88-ec.myshopify.com),
  // NOT its primary domain — the OAuth token endpoint only accepts the former.
  SHOPIFY_SHOP: z.string().optional(),
  // Preferred: Dev Dashboard app credentials, exchanged for a 24h token
  // automatically via the client-credentials grant (see connectors/shopify/auth.ts).
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  // Optional override: a static token (legacy custom app). Skips the exchange.
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default("2025-07"),
  // Skio (subscription enrichment). GraphQL endpoint is configurable in case it
  // moves; defaults to Skio's public GraphQL URL.
  SKIO_API_KEY: z.string().optional(),
  SKIO_API_URL: z.string().default("https://graphql.skio.com/v1/graphql"),
  // Stripe (print + digital both live here, split by product/price)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Comma-separated Stripe price OR product IDs that map to each line. Used to
  // split subscription_line = print | digital. Anything unmatched falls back to
  // name heuristics, then to STRIPE_DEFAULT_LINE.
  STRIPE_PRINT_PRICE_IDS: z.string().optional(),
  STRIPE_DIGITAL_PRICE_IDS: z.string().optional(),
  STRIPE_DEFAULT_LINE: z.enum(["print", "digital"]).default("print"),
  // Meta Marketing API
  META_ACCESS_TOKEN: z.string().optional(),
  META_AD_ACCOUNT_ID: z.string().optional(),
  // EasyShip (international DDP shipping + prepaid duties)
  EASYSHIP_API_TOKEN: z.string().optional(),
  // Mailgun (newsletter)
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_DOMAIN: z.string().optional(),
  // Slack (digest + failure alerts)
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_DIGEST_CHANNEL: z.string().optional(),
  SLACK_ALERT_CHANNEL: z.string().optional(),
  // Claude API (AI insights — Phase 9; confirm current model at build time)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n` +
        `See .env.example for the full list of variables.`,
    );
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** True when a connector has the minimum credentials to run. Handy for guards
 *  and for the connector-settings UI to show wired vs. not-wired sources. */
export const connectorConfigured = {
  shopify: () =>
    Boolean(
      env.SHOPIFY_SHOP &&
        (env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
          (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)),
    ),
  skio: () => Boolean(env.SKIO_API_KEY),
  stripe: () => Boolean(env.STRIPE_SECRET_KEY),
  meta: () => Boolean(env.META_ACCESS_TOKEN && env.META_AD_ACCOUNT_ID),
  mailgun: () => Boolean(env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN),
  slack: () => Boolean(env.SLACK_BOT_TOKEN),
  anthropic: () => Boolean(env.ANTHROPIC_API_KEY),
} as const;

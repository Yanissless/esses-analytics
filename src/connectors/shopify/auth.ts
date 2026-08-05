/**
 * Shopify access-token acquisition.
 *
 * Two supported modes:
 *
 *  1. **Client credentials grant (preferred).** Dev Dashboard apps don't expose a
 *     token in the UI — you exchange the app's Client ID + Secret for a token at
 *     `POST https://{shop}/admin/oauth/access_token`. Tokens last 24 hours, so we
 *     cache in-process and refresh a few minutes before expiry. Nothing to paste,
 *     nothing to rotate by hand.
 *
 *  2. **Static token.** If SHOPIFY_ADMIN_ACCESS_TOKEN is set (legacy custom app,
 *     or a token obtained another way) it's used as-is and no exchange happens.
 *
 * Gotcha worth remembering: `{shop}` must be the store's **myshopifyDomain**, not
 * its primary domain. For this store that's `9fee88-ec.myshopify.com`, while the
 * primary domain is `essesmag.myshopify.com` — using the latter fails auth.
 *
 * The grant also requires the app and store to sit in the same Shopify
 * organization, otherwise Shopify returns `shop_not_permitted`.
 */
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";

export class ShopifyAuthError extends Error {}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
  scope?: string;
}

let cached: CachedToken | null = null;

/** Refresh this long before actual expiry so a long sync can't expire mid-run. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export function shopHost(): string {
  const shop = env.SHOPIFY_SHOP;
  if (!shop) throw new ShopifyAuthError("SHOPIFY_SHOP is not set");
  return shop.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** True when either auth mode is configured. */
export function shopifyAuthConfigured(): boolean {
  if (!env.SHOPIFY_SHOP) return false;
  if (env.SHOPIFY_ADMIN_ACCESS_TOKEN) return true;
  return Boolean(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);
}

async function exchangeClientCredentials(): Promise<CachedToken> {
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ShopifyAuthError(
      "Set SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for the client-credentials grant.",
    );
  }

  const url = `https://${shopHost()}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    // Surface Shopify's own error text — 'shop_not_permitted' means the app and
    // store aren't in the same organization, which is the usual cause.
    throw new ShopifyAuthError(
      `Token exchange failed (HTTP ${res.status}) for ${shopHost()}: ${text.slice(0, 300)}`,
    );
  }

  let parsed: { access_token?: string; expires_in?: number; scope?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new ShopifyAuthError(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.access_token) {
    throw new ShopifyAuthError(`Token endpoint returned no access_token: ${text.slice(0, 200)}`);
  }

  const ttlMs = (parsed.expires_in ?? 86_399) * 1000;
  logger.info("Shopify access token obtained", {
    shop: shopHost(),
    expiresInMin: Math.round(ttlMs / 60000),
    scope: parsed.scope,
  });

  return {
    token: parsed.access_token,
    expiresAt: Date.now() + ttlMs,
    scope: parsed.scope,
  };
}

/** Current access token, exchanging/refreshing as needed. */
export async function getAccessToken(): Promise<string> {
  if (env.SHOPIFY_ADMIN_ACCESS_TOKEN) return env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  cached = await exchangeClientCredentials();
  return cached.token;
}

/** Granted scopes from the last exchange (null for a static token). */
export function grantedScopes(): string | null {
  return cached?.scope ?? null;
}

/** Drop the cached token — used by tests and after a 401. */
export function clearTokenCache(): void {
  cached = null;
}

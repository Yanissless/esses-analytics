/**
 * Shopify Admin GraphQL API client.
 *
 * Handles auth, cost-aware throttling (Shopify uses a calculated-cost leaky
 * bucket), retry/backoff on THROTTLED / 5xx, and cursor pagination. This is the
 * transport layer for the Shopify connector; mapping/upsert lives in ingest.ts.
 */
import { connectorConfigured, env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { clearTokenCache, getAccessToken, shopHost } from "./auth";

const THROTTLE_FLOOR = 100; // pause when fewer than this many cost points remain
const MAX_RETRIES = 5;

export class ShopifyConfigError extends Error {}

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: { throttleStatus?: ThrottleStatus } };
}

function endpoint(): string {
  if (!connectorConfigured.shopify()) {
    throw new ShopifyConfigError(
      "Shopify not configured — set SHOPIFY_SHOP plus either SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET or SHOPIFY_ADMIN_ACCESS_TOKEN in .env",
    );
  }
  return `https://${shopHost()}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a GraphQL operation with retry + throttle handling.
 * Throws on GraphQL errors (other than THROTTLED, which is retried).
 */
export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const url = endpoint();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": await getAccessToken(),
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (networkErr) {
      // Undici surfaces any transport-level problem as a bare "fetch failed", and
      // this machine throws one occasionally mid-run. A backfill is ~170 sequential
      // pages, so a flat sub-second retry ladder (5s of total patience) was enough
      // to lose the whole run to one blip. Back off exponentially instead, and log
      // it — a silent retry storm looks identical to a hang.
      if (attempt === MAX_RETRIES) throw networkErr;
      const waitMs = 1000 * 2 ** (attempt - 1);
      logger.warn(
        `Shopify request failed at the network layer, retrying in ${waitMs}ms`,
        { attempt, error: networkErr instanceof Error ? networkErr.message : String(networkErr) },
      );
      await sleep(waitMs);
      continue;
    }

    // A revoked/expired token → drop the cache and retry once with a fresh one.
    if (res.status === 401 && attempt < MAX_RETRIES) {
      logger.warn("Shopify returned 401 — refreshing access token", { attempt });
      clearTokenCache();
      continue;
    }

    // HTTP-level rate limit / server errors → backoff and retry.
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("Retry-After")) || attempt * 2;
      logger.warn(`Shopify HTTP ${res.status}, retrying in ${retryAfter}s`, { attempt });
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as GraphQLResponse<T>;

    // GraphQL-level throttle → wait for the bucket to refill, then retry.
    const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      const status = body.extensions?.cost?.throttleStatus;
      const waitMs = status
        ? Math.ceil((THROTTLE_FLOOR / Math.max(status.restoreRate, 1)) * 1000)
        : attempt * 1000;
      logger.warn(`Shopify THROTTLED, waiting ${waitMs}ms`, { attempt });
      await sleep(waitMs);
      continue;
    }

    if (body.errors?.length) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
    }
    if (!body.data) throw new Error("Shopify GraphQL returned no data");

    // Proactive pacing: if the bucket is running low, breathe before the next call.
    const status = body.extensions?.cost?.throttleStatus;
    if (status && status.currentlyAvailable < THROTTLE_FLOOR) {
      const waitMs = Math.ceil((THROTTLE_FLOOR / Math.max(status.restoreRate, 1)) * 1000);
      await sleep(waitMs);
    }

    return body.data;
  }

  throw new Error(`Shopify GraphQL failed after ${MAX_RETRIES} retries`);
}

export interface Connection<TNode> {
  edges: Array<{ node: TNode; cursor: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Iterate every page of a connection. `build` receives the pagination cursor and
 * returns { query, variables }; `select` extracts the Connection from the data.
 */
export async function* paginate<TNode, TData>(
  build: (after: string | null) => { query: string; variables?: Record<string, unknown> },
  select: (data: TData) => Connection<TNode>,
): AsyncGenerator<TNode> {
  let after: string | null = null;
  for (;;) {
    const { query, variables } = build(after);
    const data = await shopifyGraphQL<TData>(query, variables);
    const conn = select(data);
    for (const edge of conn.edges) yield edge.node;
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return;
    after = conn.pageInfo.endCursor;
  }
}

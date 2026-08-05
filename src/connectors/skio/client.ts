/**
 * Skio GraphQL client (subscription enrichment).
 *
 * Skio's API is Hasura-style GraphQL and mirrors Shopify's object model
 * (platformId = Shopify GID). Auth is via the API key in the Authorization
 * header. Field/table names in queries.ts are marked for verification against
 * the live schema (run an introspection once SKIO_API_KEY is set).
 */
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";

export class SkioConfigError extends Error {}

// A full Skio pass walks ~33 pages over several minutes, so a transient network
// drop mid-run is likely. Retry generously with exponential backoff rather than
// losing the whole sync to one dropped connection.
const MAX_RETRIES = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function skioGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!env.SKIO_API_KEY) {
    throw new SkioConfigError("Skio not configured — set SKIO_API_KEY in .env");
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(env.SKIO_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Skio requires the "API " prefix (verified against the live endpoint).
          Authorization: `API ${env.SKIO_API_KEY}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(500 * attempt);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("Retry-After")) || attempt * 2;
      logger.warn(`Skio HTTP ${res.status}, retrying in ${retryAfter}s`, { attempt });
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Skio HTTP ${res.status}: ${await res.text()}`);

    const body = (await res.json()) as GraphQLResponse<T>;
    if (body.errors?.length) {
      throw new Error(`Skio GraphQL error: ${JSON.stringify(body.errors)}`);
    }
    if (!body.data) throw new Error("Skio GraphQL returned no data");
    return body.data;
  }
  throw new Error(`Skio GraphQL failed after ${MAX_RETRIES} retries`);
}

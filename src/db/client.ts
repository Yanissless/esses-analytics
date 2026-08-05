/**
 * Drizzle database client (postgres.js driver).
 *
 * A single connection pool is cached on `globalThis` so Next.js hot-reload and
 * repeated script imports don't open a new pool every time. Swap the driver for
 * a serverless one (Neon/Supabase) at deploy time without touching callers.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../lib/env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  __pgClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__pgClient ??
  postgres(env.DATABASE_URL, {
    max: 10,
    // Cents are read from bigint columns; keep them as JS numbers via Drizzle's
    // bigint mode. No custom parsers needed here.
  });

if (env.NODE_ENV !== "production") {
  globalForDb.__pgClient = client;
}

export const db = drizzle(client, { schema });
export { client as pgClient, schema };

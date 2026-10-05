/**
 * Seed the initial admin user (Sam). Run with `pnpm db:seed`.
 *
 * Idempotent: re-running ensures the accounts exist and are admins, but never
 * overwrites an existing user's password (they may have changed it). Passwords
 * come from SEED_ADMIN_PASSWORD; if unset, a random one is generated and printed
 * once. Only needs DATABASE_URL + SEED_ADMIN_PASSWORD — not the full env schema.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { users } from "../src/db/schema";
import { hashPassword } from "../src/lib/auth/password";

// Only Sam is seeded: every seeded account shares SEED_ADMIN_PASSWORD, so on a public
// host extra admins must be invited from the Team page with their own one-time password.
const ADMINS = [{ email: "sam@essesmag.com", name: "Sam" }];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — see .env.example");

  let password = process.env.SEED_ADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    password = randomBytes(9).toString("base64url"); // ~12 chars
    generated = true;
  }

  const client = postgres(url, { max: 1 });
  try {
    const db = drizzle(client);
    const passwordHash = await hashPassword(password);

    for (const admin of ADMINS) {
      const email = admin.email.toLowerCase();
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing) {
        await db
          .update(users)
          .set({ role: "admin", isActive: true, name: existing.name ?? admin.name })
          .where(eq(users.id, existing.id));
        console.log(`= ${email} exists — ensured admin/active (password unchanged)`);
      } else {
        await db.insert(users).values({
          email,
          name: admin.name,
          passwordHash,
          role: "admin",
        });
        console.log(`+ created ${email} (admin)`);
      }
    }

    if (generated) {
      console.log(`\nGenerated admin password (shown once): ${password}`);
    } else {
      console.log(`\nUsed SEED_ADMIN_PASSWORD from env for any newly-created accounts.`);
    }
    console.log("Change passwords after first login.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Seed failed:", err);
  process.exit(1);
});

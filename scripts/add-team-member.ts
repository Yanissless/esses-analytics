/**
 * Add (or re-activate) one team member's login. Generalises `seed.ts`'s
 * per-admin logic so a new person — Hugh, Ojus, whoever's next — doesn't need
 * a bespoke script each time.
 *
 * Idempotent, same as `seed.ts`: re-running ensures the account exists with the
 * given name/role and is active, but never overwrites an existing password —
 * someone who already changed theirs keeps it.
 *
 * Usage: pnpm add:user -- --email=hugh@essesmag.com --name=Hugh --role=admin
 *   --role defaults to "viewer" if omitted. Valid roles: admin, viewer, marketing
 *   (see src/lib/auth/capabilities.ts for what each can see).
 *   --password sets a specific one; omitted generates a random one, printed once.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { users } from "../src/db/schema";
import { hashPassword } from "../src/lib/auth/password";
import { isRole, ROLES, type Role } from "../src/lib/auth/capabilities";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim();
  const roleRaw = arg("role") ?? "viewer";
  const passwordArg = arg("password");

  if (!email || !email.includes("@")) {
    throw new Error("Usage: pnpm add:user -- --email=name@essesmag.com --name=Name [--role=admin] [--password=...]");
  }
  if (!name) throw new Error("--name is required, e.g. --name=Hugh");
  if (!isRole(roleRaw)) {
    throw new Error(`--role must be one of: ${ROLES.join(", ")} (got "${roleRaw}")`);
  }
  const role: Role = roleRaw;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — see .env.example");

  let password = passwordArg;
  let generated = false;
  if (!password) {
    password = randomBytes(9).toString("base64url"); // ~12 chars
    generated = true;
  }

  const client = postgres(url, { max: 1 });
  try {
    const db = drizzle(client);
    const passwordHash = await hashPassword(password);

    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (existing) {
      await db
        .update(users)
        .set({ role, isActive: true, name: existing.name ?? name })
        .where(eq(users.id, existing.id));
      console.log(`= ${email} exists — ensured role=${role}, active (password unchanged)`);
    } else {
      await db.insert(users).values({ email, name, passwordHash, role });
      console.log(`+ created ${email} (${role})`);
      if (generated) {
        console.log(`\nGenerated password (shown once): ${password}`);
        console.log("Share it with them over a private channel — not chat/email — and have them change it after first login.");
      } else {
        console.log("\nUsed the password given on the command line.");
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

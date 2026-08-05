/**
 * Apply pending migrations. Run with `pnpm db:migrate`.
 * Uses a dedicated single-connection client and only needs DATABASE_URL.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — see .env.example");

  const migrationClient = postgres(url, { max: 1 });
  try {
    const db = drizzle(migrationClient);
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✓ Migrations applied");
  } finally {
    await migrationClient.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err);
  process.exit(1);
});

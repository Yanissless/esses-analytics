import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config. Column names are specified explicitly in the schema, so
 * no casing transform is applied here.
 */
export default defineConfig({
  schema: "./src/db/schema",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});

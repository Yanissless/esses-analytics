/**
 * Full database schema (Section 6). Import tables from "@/db/schema".
 * drizzle-kit reads this module (see drizzle.config.ts) to generate migrations.
 */
export * from "./enums";
export * from "./auth";
export * from "./customers";
export * from "./catalog";
export * from "./orders";
export * from "./subscriptions";
export * from "./marketing";
export * from "./social";
export * from "./markets";
export * from "./shipping";
export * from "./metrics";
export * from "./order-profit";
export * from "./ops";

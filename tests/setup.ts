/**
 * Test environment defaults. Lets modules that import the validated env schema
 * (and the lazy DB client) load without a real database. Pure-logic tests never
 * issue a query, so the dummy DATABASE_URL is never actually connected.
 */
// NODE_ENV is set to "test" by vitest already (and is read-only under Next types).
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.AUTH_SECRET ??= "test-secret-at-least-32-characters-long!!";

// Sample Stripe price-id mappings for the line-split tests.
process.env.STRIPE_PRINT_PRICE_IDS ??= "price_print_1,prod_print";
process.env.STRIPE_DIGITAL_PRICE_IDS ??= "price_digital_1,prod_digital";
process.env.STRIPE_DEFAULT_LINE ??= "print";

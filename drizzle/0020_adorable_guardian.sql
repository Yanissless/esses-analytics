ALTER TABLE "stripe_invoices" ADD COLUMN "discount_codes" text[];--> statement-breakpoint
ALTER TABLE "stripe_invoices" ADD COLUMN "discount_amount" bigint DEFAULT 0 NOT NULL;
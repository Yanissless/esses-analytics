ALTER TYPE "public"."order_type" ADD VALUE 'subscription_stripe_fulfillment';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "counts_as_revenue" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "revenue_external_source" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "amount_received_amount" bigint DEFAULT 0 NOT NULL;
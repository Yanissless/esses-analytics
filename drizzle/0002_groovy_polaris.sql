ALTER TABLE "orders" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "review_override" text;
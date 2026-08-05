CREATE TABLE "cost_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone" text NOT NULL,
	"effective_date" date NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"ship_cost_amount" bigint DEFAULT 0 NOT NULL,
	"freight_per_unit_amount" bigint DEFAULT 0 NOT NULL,
	"packaging_amount" bigint DEFAULT 0 NOT NULL,
	"pick_pack_amount" bigint DEFAULT 0 NOT NULL,
	"processing_pct" double precision DEFAULT 0 NOT NULL,
	"return_rate_pct" double precision DEFAULT 0 NOT NULL,
	"return_cost_amount" bigint DEFAULT 0 NOT NULL,
	"source" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "margin_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effective_date" date NOT NULL,
	"target_margin_pct" double precision DEFAULT 0.2 NOT NULL,
	"base_quarterly_amount" bigint DEFAULT 3000 NOT NULL,
	"base_annual_amount" bigint DEFAULT 10000 NOT NULL,
	"issues_per_quarter" double precision DEFAULT 1 NOT NULL,
	"issues_per_year" double precision DEFAULT 4 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text NOT NULL,
	"market_name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"uplift_pct" double precision DEFAULT 0 NOT NULL,
	"print_vat_pct" double precision DEFAULT 0 NOT NULL,
	"std_vat_pct" double precision DEFAULT 0 NOT NULL,
	"vat_basis" text DEFAULT 'print' NOT NULL,
	"shipping_zone" text DEFAULT 'row' NOT NULL,
	"fulfillment_origin" text DEFAULT 'US' NOT NULL,
	"fx_per_usd" double precision,
	"fx_as_of" date,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "product_costs_sku_date_unique";--> statement-breakpoint
ALTER TABLE "product_costs" ADD COLUMN "origin" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_country" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_country" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "presentment_currency" char(3);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "presentment_total_amount" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_origin_override" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_assumptions_zone_date_unique" ON "cost_assumptions" USING btree ("zone","effective_date");--> statement-breakpoint
CREATE INDEX "cost_assumptions_zone_idx" ON "cost_assumptions" USING btree ("zone");--> statement-breakpoint
CREATE UNIQUE INDEX "margin_settings_date_unique" ON "margin_settings" USING btree ("effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "market_config_country_unique" ON "market_config" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "market_config_zone_idx" ON "market_config" USING btree ("shipping_zone");--> statement-breakpoint
CREATE UNIQUE INDEX "product_costs_sku_origin_date_unique" ON "product_costs" USING btree ("sku","origin","effective_date");--> statement-breakpoint
CREATE INDEX "orders_shipping_country_idx" ON "orders" USING btree ("shipping_country");--> statement-breakpoint
CREATE INDEX "orders_needs_review_idx" ON "orders" USING btree ("needs_review");
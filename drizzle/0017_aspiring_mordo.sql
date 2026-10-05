CREATE TABLE "ltv_cac_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier" text NOT NULL,
	"tier_label" text NOT NULL,
	"route" text NOT NULL,
	"effective_date" date NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"list_price_cents" bigint DEFAULT 0 NOT NULL,
	"intro_discount_pct" double precision DEFAULT 0 NOT NULL,
	"processing_pct" double precision DEFAULT 0 NOT NULL,
	"annual_cogs_cents" bigint DEFAULT 0 NOT NULL,
	"r1" double precision NOT NULL,
	"r2" double precision NOT NULL,
	"discount_rate_pct" double precision DEFAULT 0.15 NOT NULL,
	"horizon_years" integer DEFAULT 3 NOT NULL,
	"cac_cents" bigint DEFAULT 0 NOT NULL,
	"base_share_pct" double precision,
	"target_ratio" double precision DEFAULT 3 NOT NULL,
	"source" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ltv_cac_tier_route_date_unique" ON "ltv_cac_assumptions" USING btree ("tier","route","effective_date");
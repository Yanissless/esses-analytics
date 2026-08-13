CREATE TABLE "ad_creative" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"ad_id" text NOT NULL,
	"ad_name" text,
	"campaign_id" text,
	"creative_id" text,
	"object_type" text,
	"status" text,
	"image_data" text,
	"image_mime" text,
	"image_source" text,
	"image_bytes" double precision,
	"permalink" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ad_creative_platform_ad_idx" ON "ad_creative" USING btree ("platform","ad_id");--> statement-breakpoint
CREATE INDEX "ad_creative_campaign_idx" ON "ad_creative" USING btree ("campaign_id");
CREATE TABLE "social_audience_segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"captured_on" date NOT NULL,
	"dimension" text NOT NULL,
	"key" text NOT NULL,
	"share_pct" double precision NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "social_segment_natural_key" ON "social_audience_segment" USING btree ("platform","captured_on","dimension","key");--> statement-breakpoint
CREATE INDEX "social_segment_dimension_idx" ON "social_audience_segment" USING btree ("dimension");
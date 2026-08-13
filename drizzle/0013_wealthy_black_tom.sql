CREATE TABLE "social_insights_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"captured_on" date NOT NULL,
	"reach" integer,
	"views" integer,
	"profile_views" integer,
	"accounts_engaged" integer,
	"total_interactions" integer,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "social_insights_platform_day_idx" ON "social_insights_daily" USING btree ("platform","captured_on");--> statement-breakpoint
CREATE INDEX "social_insights_captured_on_idx" ON "social_insights_daily" USING btree ("captured_on");
CREATE TABLE "content_day_quality" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"rows_returned" integer DEFAULT 0 NOT NULL,
	"has_other_row" boolean DEFAULT false NOT NULL,
	"other_sessions" bigint DEFAULT 0 NOT NULL,
	"sampled" boolean DEFAULT false NOT NULL,
	"total_sessions" bigint DEFAULT 0 NOT NULL,
	"total_views" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"page_path" text NOT NULL,
	"page_title" text,
	"sessions" bigint DEFAULT 0 NOT NULL,
	"views" bigint DEFAULT 0 NOT NULL,
	"users" bigint DEFAULT 0 NOT NULL,
	"engaged_sessions" bigint DEFAULT 0 NOT NULL,
	"engagement_seconds" bigint DEFAULT 0 NOT NULL,
	"entrances" bigint DEFAULT 0 NOT NULL,
	"is_provisional" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_day_quality_date_key" ON "content_day_quality" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "content_metrics_date_path_key" ON "content_metrics" USING btree ("date","page_path");--> statement-breakpoint
CREATE INDEX "content_metrics_path_idx" ON "content_metrics" USING btree ("page_path");
CREATE TABLE "social_audience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"captured_on" date NOT NULL,
	"followers" integer NOT NULL,
	"following" integer,
	"posts" integer,
	"source" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "social_audience_platform_day_idx" ON "social_audience" USING btree ("platform","captured_on");--> statement-breakpoint
CREATE INDEX "social_audience_captured_on_idx" ON "social_audience" USING btree ("captured_on");--> statement-breakpoint
CREATE INDEX "social_audience_source_idx" ON "social_audience" USING btree ("source");
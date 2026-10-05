CREATE TABLE "acquisition_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" text NOT NULL,
	"campaign_name" text NOT NULL,
	"note" text,
	"tagged_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "acquisition_campaigns_campaign_id_unique" ON "acquisition_campaigns" USING btree ("campaign_id");
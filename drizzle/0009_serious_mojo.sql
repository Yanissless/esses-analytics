CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_start" date NOT NULL,
	"metric" text NOT NULL,
	"target_amount" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"note" text,
	CONSTRAINT "goals_period_metric_unique" UNIQUE("period_start","metric")
);
--> statement-breakpoint
CREATE INDEX "goals_period_idx" ON "goals" USING btree ("period_start");
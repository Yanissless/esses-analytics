CREATE TABLE "order_profit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_number" text,
	"processed_on" date,
	"country" text,
	"revenue_class" text NOT NULL,
	"order_type" text,
	"origin" text,
	"zone" text,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"gross_amount" bigint DEFAULT 0 NOT NULL,
	"net_ex_vat_amount" bigint DEFAULT 0 NOT NULL,
	"refunds_amount" bigint DEFAULT 0 NOT NULL,
	"discounts_amount" bigint DEFAULT 0 NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"cogs_amount" bigint DEFAULT 0 NOT NULL,
	"uncosted_units" integer DEFAULT 0 NOT NULL,
	"ship_cost_amount" bigint DEFAULT 0 NOT NULL,
	"ship_charged_amount" bigint DEFAULT 0 NOT NULL,
	"duties_amount" bigint DEFAULT 0 NOT NULL,
	"other_fulfil_amount" bigint DEFAULT 0 NOT NULL,
	"processing_amount" bigint DEFAULT 0 NOT NULL,
	"ship_basis" text,
	"cm1_amount" bigint DEFAULT 0 NOT NULL,
	"cm2_amount" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_profit_order_unique" ON "order_profit" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_profit_date_idx" ON "order_profit" USING btree ("processed_on");--> statement-breakpoint
CREATE INDEX "order_profit_class_idx" ON "order_profit" USING btree ("revenue_class");--> statement-breakpoint
CREATE INDEX "order_profit_cm2_idx" ON "order_profit" USING btree ("cm2_amount");--> statement-breakpoint
CREATE INDEX "order_profit_country_idx" ON "order_profit" USING btree ("country");
CREATE TABLE "fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_fulfillment_id" text NOT NULL,
	"name" text,
	"tracking_company" text,
	"tracking_number" text,
	"tracking_url" text,
	"location_name" text,
	"service_name" text,
	"service_type" text,
	"status" text,
	"total_quantity" integer,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid,
	"fulfillment_id" uuid,
	"order_id" uuid,
	"vendor" text NOT NULL,
	"tracking_number" text,
	"shipped_on" date,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"ship_amount" bigint DEFAULT 0 NOT NULL,
	"duties_amount" bigint DEFAULT 0 NOT NULL,
	"surcharge_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"attribution" text DEFAULT 'itemised' NOT NULL,
	"matched_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor" text NOT NULL,
	"invoice_ref" text,
	"invoice_date" date,
	"period_start" date,
	"period_end" date,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"stated_shipment_count" integer,
	"allocation_method" text DEFAULT 'itemised' NOT NULL,
	"allocated_amount" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_rate_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"carrier_pattern" text,
	"service_pattern" text,
	"country_code" text,
	"zone" text,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"expected_cost_amount" bigint NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"effective_date" date NOT NULL,
	"source" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_charges" ADD CONSTRAINT "shipping_charges_invoice_id_shipping_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."shipping_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_charges" ADD CONSTRAINT "shipping_charges_fulfillment_id_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."fulfillments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_charges" ADD CONSTRAINT "shipping_charges_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillments_shopify_id_unique" ON "fulfillments" USING btree ("shopify_fulfillment_id");--> statement-breakpoint
CREATE INDEX "fulfillments_order_idx" ON "fulfillments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "fulfillments_tracking_number_idx" ON "fulfillments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "fulfillments_company_idx" ON "fulfillments" USING btree ("tracking_company");--> statement-breakpoint
CREATE INDEX "fulfillments_location_idx" ON "fulfillments" USING btree ("location_name");--> statement-breakpoint
CREATE INDEX "shipping_charges_invoice_idx" ON "shipping_charges" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "shipping_charges_fulfillment_idx" ON "shipping_charges" USING btree ("fulfillment_id");--> statement-breakpoint
CREATE INDEX "shipping_charges_order_idx" ON "shipping_charges" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipping_charges_tracking_idx" ON "shipping_charges" USING btree ("tracking_number");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_invoices_vendor_ref_unique" ON "shipping_invoices" USING btree ("vendor","invoice_ref");--> statement-breakpoint
CREATE INDEX "shipping_invoices_vendor_idx" ON "shipping_invoices" USING btree ("vendor");--> statement-breakpoint
CREATE INDEX "shipping_invoices_period_idx" ON "shipping_invoices" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_rate_rules_label_date_unique" ON "shipping_rate_rules" USING btree ("label","effective_date");--> statement-breakpoint
CREATE INDEX "shipping_rate_rules_priority_idx" ON "shipping_rate_rules" USING btree ("priority");
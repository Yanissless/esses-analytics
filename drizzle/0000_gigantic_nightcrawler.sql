CREATE TYPE "public"."ad_platform" AS ENUM('meta', 'google_ads', 'tiktok', 'other');--> statement-breakpoint
CREATE TYPE "public"."cost_source" AS ENUM('manual', 'csv_import', 'shopify_metafield');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('one_time', 'subscription_shopify');--> statement-breakpoint
CREATE TYPE "public"."sub_status" AS ENUM('active', 'trialing', 'past_due', 'paused', 'canceled', 'expired', 'unpaid');--> statement-breakpoint
CREATE TYPE "public"."subscription_line" AS ENUM('print', 'digital');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('backfill', 'incremental');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"variant_id" uuid,
	"cost_amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"effective_date" date NOT NULL,
	"source" "cost_source" DEFAULT 'manual' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"shopify_variant_id" text,
	"sku" text,
	"title" text,
	"price_amount" bigint,
	"currency" char(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_product_id" text,
	"title" text,
	"handle" text,
	"product_type" text,
	"vendor" text,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"phone" text,
	"name" text,
	"shopify_customer_id" text,
	"skio_storefront_user_id" text,
	"stripe_customer_id" text,
	"acquisition_channel" text,
	"acquisition_campaign" text,
	"acquisition_offer" text,
	"acquired_at" timestamp with time zone,
	"first_order_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_line_item_id" text,
	"variant_id" uuid,
	"sku" text,
	"title" text,
	"variant_title" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"price_amount" bigint DEFAULT 0 NOT NULL,
	"total_discount_amount" bigint DEFAULT 0 NOT NULL,
	"selling_plan_id" text,
	"is_subscription" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_order_id" text NOT NULL,
	"customer_id" uuid,
	"order_type" "order_type" DEFAULT 'one_time' NOT NULL,
	"acquisition_order" boolean DEFAULT false NOT NULL,
	"subscription_meta_id" uuid,
	"order_number" text,
	"processed_at" timestamp with time zone,
	"shopify_created_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"subtotal_amount" bigint DEFAULT 0 NOT NULL,
	"total_discounts_amount" bigint DEFAULT 0 NOT NULL,
	"shipping_amount" bigint DEFAULT 0 NOT NULL,
	"total_tax_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"total_refunded_amount" bigint DEFAULT 0 NOT NULL,
	"financial_status" text,
	"fulfillment_status" text,
	"source_name" text,
	"test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_refund_id" text,
	"refunded_at" timestamp with time zone,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stripe_line_id" text,
	"price_id" text,
	"product_id" text,
	"subscription_line" "subscription_line",
	"description" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_subscription_id" text,
	"customer_id" uuid,
	"subscription_line" "subscription_line",
	"status" text,
	"paid" boolean DEFAULT false NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"subtotal_amount" bigint DEFAULT 0 NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"amount_due_amount" bigint DEFAULT 0 NOT NULL,
	"amount_paid_amount" bigint DEFAULT 0 NOT NULL,
	"invoiced_at" timestamp with time zone,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text,
	"subscription_line" "subscription_line" NOT NULL,
	"status" "sub_status",
	"raw_status" text,
	"product_id" text,
	"price_id" text,
	"plan_nickname" text,
	"interval" text,
	"interval_count" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"mrr_amount" bigint DEFAULT 0 NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"started_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_meta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"skio_subscription_id" text,
	"selling_plan_id" text,
	"selling_plan_name" text,
	"status" "sub_status",
	"raw_status" text,
	"started_at" timestamp with time zone,
	"next_billing_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"billing_interval" text,
	"billing_interval_count" integer,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"mrr_amount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_inventory_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"placement" text NOT NULL,
	"advertiser" text,
	"campaign" text,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"date" date NOT NULL,
	"account_id" text,
	"campaign_id" text,
	"campaign_name" text,
	"adset_id" text,
	"adset_name" text,
	"ad_id" text,
	"ad_name" text,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"spend_amount" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"platform_conversions" double precision DEFAULT 0 NOT NULL,
	"platform_conversion_value_amount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribution_touchpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"session_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"source" text,
	"medium" text,
	"campaign" text,
	"content" text,
	"term" text,
	"click_id" text,
	"click_id_type" text,
	"landing_url" text,
	"referrer" text,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"channel" text,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"revenue_amount" bigint DEFAULT 0 NOT NULL,
	"new_customer_revenue_amount" bigint DEFAULT 0 NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	"new_customers" integer DEFAULT 0 NOT NULL,
	"returning_customers" integer DEFAULT 0 NOT NULL,
	"ad_spend_amount" bigint DEFAULT 0 NOT NULL,
	"cogs_amount" bigint DEFAULT 0 NOT NULL,
	"shipping_amount" bigint DEFAULT 0 NOT NULL,
	"processing_amount" bigint DEFAULT 0 NOT NULL,
	"discounts_amount" bigint DEFAULT 0 NOT NULL,
	"refunds_amount" bigint DEFAULT 0 NOT NULL,
	"cm1_amount" bigint DEFAULT 0 NOT NULL,
	"cm2_amount" bigint DEFAULT 0 NOT NULL,
	"cm3_amount" bigint DEFAULT 0 NOT NULL,
	"mer" double precision,
	"amer" double precision,
	"roas" double precision,
	"cac" double precision,
	"aov" double precision,
	"unknown_cogs_line_count" integer DEFAULT 0 NOT NULL,
	"unknown_cogs_order_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_metrics_date_channel_unique" UNIQUE NULLS NOT DISTINCT("date","channel")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"mode" "sync_mode" NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_in" integer DEFAULT 0 NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"window_since" timestamp with time zone,
	"window_until" timestamp with time zone,
	"cursor" text,
	"error" text,
	"warnings" jsonb
);
--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_invoice_line_items" ADD CONSTRAINT "stripe_invoice_line_items_invoice_id_stripe_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."stripe_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_invoices" ADD CONSTRAINT "stripe_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_subscriptions" ADD CONSTRAINT "stripe_subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_meta" ADD CONSTRAINT "subscription_meta_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_touchpoints" ADD CONSTRAINT "attribution_touchpoints_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_touchpoints" ADD CONSTRAINT "attribution_touchpoints_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "product_costs_sku_date_unique" ON "product_costs" USING btree ("sku","effective_date");--> statement-breakpoint
CREATE INDEX "product_costs_sku_idx" ON "product_costs" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_shopify_id_unique" ON "product_variants" USING btree ("shopify_variant_id");--> statement-breakpoint
CREATE INDEX "variants_sku_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "products_shopify_id_unique" ON "products" USING btree ("shopify_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_unique" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_shopify_id_unique" ON "customers" USING btree ("shopify_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_stripe_id_unique" ON "customers" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_skio_id_unique" ON "customers" USING btree ("skio_storefront_user_id");--> statement-breakpoint
CREATE INDEX "customers_acquisition_idx" ON "customers" USING btree ("acquired_at","acquisition_channel");--> statement-breakpoint
CREATE UNIQUE INDEX "line_items_shopify_id_unique" ON "order_line_items" USING btree ("shopify_line_item_id");--> statement-breakpoint
CREATE INDEX "line_items_order_idx" ON "order_line_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "line_items_sku_idx" ON "order_line_items" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_shopify_id_unique" ON "orders" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_processed_at_idx" ON "orders" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "orders_type_idx" ON "orders" USING btree ("order_type");--> statement-breakpoint
CREATE INDEX "orders_subscription_meta_idx" ON "orders" USING btree ("subscription_meta_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_shopify_id_unique" ON "refunds" USING btree ("shopify_refund_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_invoice_line_id_unique" ON "stripe_invoice_line_items" USING btree ("stripe_line_id");--> statement-breakpoint
CREATE INDEX "stripe_invoice_line_invoice_idx" ON "stripe_invoice_line_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_invoice_id_unique" ON "stripe_invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "stripe_invoice_customer_idx" ON "stripe_invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "stripe_invoice_sub_idx" ON "stripe_invoices" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "stripe_invoice_invoiced_at_idx" ON "stripe_invoices" USING btree ("invoiced_at");--> statement-breakpoint
CREATE INDEX "stripe_invoice_line_idx" ON "stripe_invoices" USING btree ("subscription_line");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_sub_id_unique" ON "stripe_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "stripe_sub_customer_idx" ON "stripe_subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "stripe_sub_line_idx" ON "stripe_subscriptions" USING btree ("subscription_line");--> statement-breakpoint
CREATE INDEX "stripe_sub_status_idx" ON "stripe_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "submeta_skio_id_unique" ON "subscription_meta" USING btree ("skio_subscription_id");--> statement-breakpoint
CREATE INDEX "submeta_customer_idx" ON "subscription_meta" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "submeta_status_idx" ON "subscription_meta" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inventory_date_idx" ON "ad_inventory_delivery" USING btree ("date");--> statement-breakpoint
CREATE INDEX "inventory_placement_idx" ON "ad_inventory_delivery" USING btree ("placement");--> statement-breakpoint
CREATE INDEX "inventory_advertiser_idx" ON "ad_inventory_delivery" USING btree ("advertiser");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_natural_key" ON "ad_spend" USING btree ("platform","account_id","date","ad_id");--> statement-breakpoint
CREATE INDEX "ad_spend_date_idx" ON "ad_spend" USING btree ("date");--> statement-breakpoint
CREATE INDEX "ad_spend_campaign_idx" ON "ad_spend" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "touchpoints_customer_idx" ON "attribution_touchpoints" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "touchpoints_session_idx" ON "attribution_touchpoints" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "touchpoints_occurred_at_idx" ON "attribution_touchpoints" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "touchpoints_channel_idx" ON "attribution_touchpoints" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "touchpoints_order_idx" ON "attribution_touchpoints" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "daily_metrics_date_idx" ON "daily_metrics" USING btree ("date");--> statement-breakpoint
CREATE INDEX "sync_runs_source_started_idx" ON "sync_runs" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");
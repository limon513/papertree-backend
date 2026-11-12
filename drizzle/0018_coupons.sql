CREATE TABLE "coupons" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "coupons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"note" text,
	"type" text NOT NULL,
	"value" numeric(12, 2),
	"max_discount" numeric(12, 2),
	"min_order" numeric(12, 2),
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"usage_limit" integer,
	"per_customer_limit" integer DEFAULT 1,
	"new_customers_only" boolean DEFAULT false NOT NULL,
	"phone" text,
	"items" jsonb DEFAULT '{"productIds":[],"categoryIds":[],"brandIds":[]}'::jsonb NOT NULL,
	"on_sale_items" boolean DEFAULT true NOT NULL,
	"with_bulk" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code"),
	CONSTRAINT "coupons_type_value" CHECK (("coupons"."type" = 'percent' and "coupons"."value" > 0 and "coupons"."value" <= 90) or ("coupons"."type" = 'fixed' and "coupons"."value" > 0) or ("coupons"."type" = 'free_delivery' and "coupons"."value" is null)),
	CONSTRAINT "coupons_numbers" CHECK ("coupons"."used_count" >= 0 and coalesce("coupons"."usage_limit", 1) > 0 and coalesce("coupons"."per_customer_limit", 1) > 0 and coalesce("coupons"."max_discount", 1) > 0 and coalesce("coupons"."min_order", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_id" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_discount" numeric(12, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_coupon_id_idx" ON "orders" USING btree ("coupon_id") WHERE "orders"."coupon_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_money_not_negative" CHECK ("orders"."total" >= 0 and "orders"."discount" >= 0 and "orders"."bulk_discount" >= 0 and "orders"."coupon_discount" >= 0 and "orders"."delivery_fee" >= 0);
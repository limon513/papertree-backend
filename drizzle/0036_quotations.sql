CREATE SEQUENCE "public"."quotation_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1;--> statement-breakpoint
CREATE TABLE "quotation_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quotation_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"quotation_id" bigint NOT NULL,
	"product_id" bigint,
	"variant_id" bigint,
	"name" text NOT NULL,
	"variant_label" text,
	"sku" text,
	"image_id" bigint,
	"regular_price" numeric(12, 2) NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"bulk_percent" numeric(5, 2),
	"bulk_discount" numeric(12, 2) DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quotations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" integer DEFAULT nextval('quotation_number_seq') NOT NULL,
	"public_token" text NOT NULL,
	"source" text NOT NULL,
	"type" text DEFAULT 'retail' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"customer_id" bigint,
	"name" text NOT NULL,
	"organisation" text,
	"phone" text NOT NULL,
	"email" text,
	"note" text,
	"subtotal" numeric(12, 2) NOT NULL,
	"bulk_discount" numeric(12, 2) DEFAULT 0 NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"order_id" bigint,
	"ordered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_number_unique" UNIQUE("number"),
	CONSTRAINT "quotations_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quotation_items_quotation_id_idx" ON "quotation_items" USING btree ("quotation_id");--> statement-breakpoint
CREATE INDEX "quotations_status_idx" ON "quotations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "quotations_phone_idx" ON "quotations" USING btree ("phone");
CREATE SEQUENCE "public"."purchase_order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1;--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" integer DEFAULT nextval('purchase_order_number_seq') NOT NULL,
	"order_id" bigint NOT NULL,
	"brand_id" bigint,
	"brand_name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"ship_to" text NOT NULL,
	"note" text,
	"sent_to" text,
	"lines" jsonb,
	"sent_at" timestamp with time zone,
	"sent_by" bigint,
	"times_sent" integer DEFAULT 0 NOT NULL,
	"cancel_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "order_email" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "ships_to" text DEFAULT 'shop' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "supplied_by_brand" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_sent_by_admin_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_order_brand_idx" ON "purchase_orders" USING btree ("order_id","brand_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status");
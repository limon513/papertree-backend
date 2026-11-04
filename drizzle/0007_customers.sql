CREATE TABLE "customer_addresses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_addresses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint NOT NULL,
	"label" text,
	"recipient_name" text,
	"recipient_phone" text,
	"district_id" text NOT NULL,
	"area_id" text,
	"address" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "business_status" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "trade_license" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "wholesale_terms" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_addresses_one_default_idx" ON "customer_addresses" USING btree ("customer_id") WHERE "customer_addresses"."is_default";--> statement-breakpoint
CREATE INDEX "customers_business_status_idx" ON "customers" USING btree ("business_status") WHERE "customers"."business_status" is not null;--> statement-breakpoint
-- Business customers added before approvals existed were added by staff, so they count as approved.
UPDATE "customers" SET "business_status" = 'approved' WHERE "type" = 'business';--> statement-breakpoint
-- Save each customer's latest order address, to fill in their next order.
INSERT INTO "customer_addresses" ("customer_id", "district_id", "area_id", "address", "is_default")
SELECT DISTINCT ON ("customer_id") "customer_id", "district_id", "area_id", "address", true
FROM "orders" WHERE "customer_id" IS NOT NULL
ORDER BY "customer_id", "created_at" DESC;

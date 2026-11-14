ALTER TABLE "orders" ADD COLUMN "consignment_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "courier_status" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "courier_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "courier_sent_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_consignment_id_idx" ON "orders" USING btree ("consignment_id") WHERE "orders"."consignment_id" is not null;
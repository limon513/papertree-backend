ALTER TABLE "products" ADD COLUMN "bulk_discount" jsonb;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "bulk_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "bulk_discount" numeric(12, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "bulk_discount" numeric(12, 2) DEFAULT 0 NOT NULL;
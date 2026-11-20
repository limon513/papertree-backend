ALTER TABLE "customers" ADD COLUMN "last_wishlist_alert_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD COLUMN "alerted_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD COLUMN "alerted_in_stock" boolean;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD COLUMN "last_alert_at" timestamp with time zone;
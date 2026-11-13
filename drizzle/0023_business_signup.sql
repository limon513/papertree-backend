ALTER TABLE "customers" ADD COLUMN "business_type" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "business_address" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "business_applied_at" timestamp with time zone;
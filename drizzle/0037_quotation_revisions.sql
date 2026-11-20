ALTER TABLE "quotations" ADD COLUMN "delivery_fee" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "terms" text;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "replaces_id" bigint;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "times_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_replaces_id_quotations_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."quotations"("id") ON DELETE set null ON UPDATE no action;
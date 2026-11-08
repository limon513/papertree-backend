CREATE TABLE "product_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"details" text NOT NULL,
	"query" text,
	"status" text DEFAULT 'new' NOT NULL,
	"staff_note" text,
	"handled_by" bigint,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_handled_by_admin_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_requests_status_idx" ON "product_requests" USING btree ("status","created_at");
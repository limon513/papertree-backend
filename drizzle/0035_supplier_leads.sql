CREATE TABLE "supplier_leads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_leads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"location" text,
	"products" text NOT NULL,
	"ways" text[] DEFAULT '{}' NOT NULL,
	"link" text,
	"message" text,
	"status" text DEFAULT 'new' NOT NULL,
	"staff_note" text,
	"handled_by" bigint,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_leads" ADD CONSTRAINT "supplier_leads_handled_by_admin_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_leads_status_idx" ON "supplier_leads" USING btree ("status","created_at");
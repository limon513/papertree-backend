CREATE SEQUENCE "public"."custom_request_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1;--> statement-breakpoint
CREATE TABLE "custom_request_files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "custom_request_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" bigint,
	"customer_id" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "custom_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" integer DEFAULT nextval('custom_request_number_seq') NOT NULL,
	"kind" text NOT NULL,
	"specs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"notes" text,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"city" text,
	"customer_id" bigint,
	"status" text DEFAULT 'new' NOT NULL,
	"staff_note" text,
	"handled_by" bigint,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_requests_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "custom_request_id" bigint;--> statement-breakpoint
ALTER TABLE "custom_request_files" ADD CONSTRAINT "custom_request_files_request_id_custom_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."custom_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_request_files" ADD CONSTRAINT "custom_request_files_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_handled_by_admin_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_request_files_request_idx" ON "custom_request_files" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "custom_requests_status_idx" ON "custom_requests" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_custom_request_id_custom_requests_id_fk" FOREIGN KEY ("custom_request_id") REFERENCES "public"."custom_requests"("id") ON DELETE set null ON UPDATE no action;
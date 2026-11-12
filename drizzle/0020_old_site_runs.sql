CREATE TABLE "old_site_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "old_site_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"site" text NOT NULL,
	"status" text DEFAULT 'reading' NOT NULL,
	"step" text,
	"product_limit" integer,
	"products_total" integer DEFAULT 0 NOT NULL,
	"products_read" integer DEFAULT 0 NOT NULL,
	"categories" integer DEFAULT 0 NOT NULL,
	"addresses" integer DEFAULT 0 NOT NULL,
	"import_job_id" bigint,
	"error" text,
	"created_by" bigint,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "old_site_runs" ADD CONSTRAINT "old_site_runs_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "old_site_runs" ADD CONSTRAINT "old_site_runs_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
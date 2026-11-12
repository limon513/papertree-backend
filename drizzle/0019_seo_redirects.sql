CREATE TABLE "not_found_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "not_found_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"path" text NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"referrer" text,
	"ignored" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "not_found_log_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "old_site_urls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "old_site_urls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"old_id" integer,
	"suggested_path" text,
	"suggested_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "old_site_urls_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "redirects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"code" integer DEFAULT 301 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_from_path_unique" UNIQUE("from_path")
);
--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "not_found_log_last_seen_idx" ON "not_found_log" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "old_site_urls_kind_idx" ON "old_site_urls" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "redirects_to_path_idx" ON "redirects" USING btree ("to_path");
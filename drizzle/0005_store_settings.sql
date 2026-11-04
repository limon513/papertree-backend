CREATE TABLE "delivery_zones" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "delivery_zones_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"fee" numeric(12, 2) NOT NULL,
	"free_above" numeric(12, 2),
	"included_kg" numeric(6, 2),
	"extra_per_kg" numeric(12, 2),
	"delivery_time" text,
	"district_ids" text[] DEFAULT '{}' NOT NULL,
	"area_ids" text[] DEFAULT '{}' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zones_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_zones_one_default_idx" ON "delivery_zones" USING btree ("is_default") WHERE "delivery_zones"."is_default";--> statement-breakpoint
-- Starting delivery zones (typical courier rates; change them in Settings > Delivery).
INSERT INTO "delivery_zones" ("name", "fee", "included_kg", "extra_per_kg", "delivery_time", "district_ids", "area_ids", "is_default", "sort_order") VALUES
  ('Dhaka City', 70, 1, 15, '1–2 days', '{}', '{dhaka-adabor,dhaka-badda,dhaka-banani,dhaka-bangshal,dhaka-bhashantek,dhaka-bhatara,dhaka-bimanbandar,dhaka-cantonment,dhaka-chawkbazar,dhaka-dakshinkhan,dhaka-darus-salam,dhaka-demra,dhaka-dhanmondi,dhaka-gendaria,dhaka-gulshan,dhaka-hatirjheel,dhaka-hazaribagh,dhaka-jatrabari,dhaka-kadamtali,dhaka-kafrul,dhaka-kalabagan,dhaka-kamrangirchar,dhaka-khilgaon,dhaka-khilkhet,dhaka-kotwali,dhaka-lalbagh,dhaka-mirpur,dhaka-mohammadpur,dhaka-motijheel,dhaka-mugda,dhaka-new-market,dhaka-pallabi,dhaka-paltan,dhaka-ramna,dhaka-rampura,dhaka-rupnagar,dhaka-sabujbagh,dhaka-shah-ali,dhaka-shahbagh,dhaka-shahjahanpur,dhaka-sher-e-bangla-nagar,dhaka-shyampur,dhaka-sutrapur,dhaka-tejgaon,dhaka-tejgaon-industrial-area,dhaka-turag,dhaka-uttara-east,dhaka-uttara-west,dhaka-uttarkhan,dhaka-vatara,dhaka-wari}', false, 0),
  ('Dhaka suburbs', 100, 1, 20, '2–3 days', '{41,43}', '{366,369,367,368,365}', false, 1),
  ('Outside Dhaka', 130, 1, 25, '3–5 days', '{}', '{}', true, 2);

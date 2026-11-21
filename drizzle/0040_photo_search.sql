-- Search by photo needs pgvector (on Neon it is built in; on a server: apt install postgresql-17-pgvector).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "image_vectors" (
	"media_id" bigint PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_searches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "photo_searches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"results" integer NOT NULL,
	"best_score" real,
	"matched" boolean NOT NULL,
	"cropped" boolean DEFAULT false NOT NULL,
	"best_product_id" bigint,
	"customer_id" bigint,
	"device" text,
	"photo_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_requests" ADD COLUMN "photo_key" text;--> statement-breakpoint
ALTER TABLE "image_vectors" ADD CONSTRAINT "image_vectors_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_searches" ADD CONSTRAINT "photo_searches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_searches_created_idx" ON "photo_searches" USING btree ("created_at");
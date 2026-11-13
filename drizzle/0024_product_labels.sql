CREATE TABLE "labels" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color" text DEFAULT 'green' NOT NULL,
	"show_on_cards" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_labels" (
	"product_id" bigint NOT NULL,
	"label_id" bigint NOT NULL,
	CONSTRAINT "product_labels_product_id_label_id_pk" PRIMARY KEY("product_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_name_lower_idx" ON "labels" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "product_labels_label_id_idx" ON "product_labels" USING btree ("label_id");
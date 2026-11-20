CREATE TABLE "customer_activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"product_id" bigint,
	"query" text,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_login_as_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" bigint NOT NULL,
	"admin_user_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD COLUMN "acting_admin_id" bigint;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_activity" ADD CONSTRAINT "customer_activity_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_login_as_tokens" ADD CONSTRAINT "customer_login_as_tokens_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_login_as_tokens" ADD CONSTRAINT "customer_login_as_tokens_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_activity_customer_idx" ON "customer_activity" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_activity_created_idx" ON "customer_activity" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_acting_admin_id_admin_users_id_fk" FOREIGN KEY ("acting_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;
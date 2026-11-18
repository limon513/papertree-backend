CREATE TABLE "online_payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "online_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"tran_id" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'BDT' NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"sandbox" text NOT NULL,
	"session_key" text,
	"val_id" text,
	"bank_tran_id" text,
	"card_type" text,
	"risk_level" text,
	"reason" text,
	"payment_id" bigint,
	"details" jsonb,
	"paid_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "online_payments_amount_positive" CHECK ("online_payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_payment_id_order_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."order_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "online_payments_tran_id_idx" ON "online_payments" USING btree ("tran_id");--> statement-breakpoint
CREATE UNIQUE INDEX "online_payments_payment_id_idx" ON "online_payments" USING btree ("payment_id") WHERE "online_payments"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "online_payments_order_id_idx" ON "online_payments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "online_payments_started_idx" ON "online_payments" USING btree ("created_at") WHERE "online_payments"."status" = 'started';
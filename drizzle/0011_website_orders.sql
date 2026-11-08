ALTER TABLE "orders" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_public_token_unique" UNIQUE("public_token");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_request_id_unique" UNIQUE("request_id");
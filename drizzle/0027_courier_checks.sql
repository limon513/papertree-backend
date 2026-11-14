CREATE TABLE "courier_checks" (
	"phone" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"data" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);

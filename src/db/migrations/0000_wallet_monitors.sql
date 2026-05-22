CREATE TABLE IF NOT EXISTS "wallet_monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"watched_wallet" text NOT NULL,
	"label" text,
	"alert_on_fill" boolean DEFAULT true NOT NULL,
	"alert_on_position_change" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_monitors_user_wallet_unique" UNIQUE("user_id","watched_wallet")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_monitors" ADD CONSTRAINT "wallet_monitors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

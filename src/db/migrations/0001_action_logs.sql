DO $$ BEGIN
 CREATE TYPE "public"."action_outcome" AS ENUM('success', 'error');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "action_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"command" text NOT NULL,
	"args" jsonb,
	"outcome" "action_outcome" NOT NULL,
	"error_code" text,
	"error_category" text,
	"duration_ms" bigint NOT NULL,
	"tx_signature" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_logs_user_idx" ON "action_logs" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_logs_cmd_idx" ON "action_logs" USING btree ("command","created_at");

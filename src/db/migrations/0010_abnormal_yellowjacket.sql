CREATE TYPE "public"."guardian_action" AS ENUM('notify', 'suggest', 'auto_close', 'auto_reduce', 'auto_margin');--> statement-breakpoint
CREATE TYPE "public"."guardian_rule_type" AS ENUM('liq_distance', 'drawdown', 'pnl_target', 'funding_drain', 'exposure_limit', 'margin_ratio');--> statement-breakpoint
CREATE TABLE "guardian_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"rule_type" "guardian_rule_type" NOT NULL,
	"symbol" text,
	"threshold" numeric(12, 4) NOT NULL,
	"direction" text NOT NULL,
	"action" "guardian_action" DEFAULT 'suggest' NOT NULL,
	"action_param" numeric(12, 4),
	"enabled" boolean DEFAULT true NOT NULL,
	"cooldown_sec" integer DEFAULT 300 NOT NULL,
	"last_triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardian_rules" ADD CONSTRAINT "guardian_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
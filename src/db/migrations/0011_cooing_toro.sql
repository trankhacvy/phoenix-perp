ALTER TYPE "public"."guardian_rule_type" ADD VALUE 'trailing_stop';--> statement-breakpoint
ALTER TYPE "public"."guardian_rule_type" ADD VALUE 'breakeven';--> statement-breakpoint
ALTER TABLE "guardian_rules" ADD COLUMN "side" text;
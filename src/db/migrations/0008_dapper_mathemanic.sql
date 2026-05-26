CREATE TYPE "public"."fee_mode" AS ENUM('eco', 'normal', 'turbo', 'custom');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "confirm_trades" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "confirm_close" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "fee_mode" "fee_mode" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "custom_fee_sol" numeric(12, 9);--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_tp_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_sl_pct" numeric(5, 2);
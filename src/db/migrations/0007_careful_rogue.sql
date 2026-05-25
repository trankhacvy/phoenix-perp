CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"action" text NOT NULL,
	"margin_usdc" numeric(20, 6),
	"leverage" numeric(10, 2),
	"notional_usdc" numeric(20, 6) NOT NULL,
	"base_units" text NOT NULL,
	"mark_price" numeric(20, 6) NOT NULL,
	"fee_usdc" numeric(20, 6),
	"close_fraction" numeric(5, 4),
	"tx_signature" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trades_user_idx" ON "trades" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_symbol_idx" ON "trades" USING btree ("symbol","created_at");--> statement-breakpoint
CREATE INDEX "trades_created_at_idx" ON "trades" USING btree ("created_at");
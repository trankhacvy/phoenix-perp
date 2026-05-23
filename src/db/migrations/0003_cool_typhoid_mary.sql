CREATE TABLE "leaderboard_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"collateral_balance" numeric(20, 6) DEFAULT '0' NOT NULL,
	"effective_collateral" numeric(20, 6) DEFAULT '0' NOT NULL,
	"unrealized_pnl" numeric(20, 6) DEFAULT '0' NOT NULL,
	"portfolio_value" numeric(20, 6) DEFAULT '0' NOT NULL,
	"accumulated_funding" numeric(20, 6) DEFAULT '0' NOT NULL,
	"risk_tier" text,
	"position_count" integer DEFAULT 0 NOT NULL,
	"total_volume" numeric(24, 6),
	"realized_pnl" numeric(20, 6),
	"win_count" integer,
	"loss_count" integer,
	"total_trades" integer,
	"discovered_via" text DEFAULT 'gpa' NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "leaderboard_snapshots_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE INDEX "lb_portfolio_value_idx" ON "leaderboard_snapshots" USING btree ("portfolio_value");--> statement-breakpoint
CREATE INDEX "lb_realized_pnl_idx" ON "leaderboard_snapshots" USING btree ("realized_pnl");--> statement-breakpoint
CREATE INDEX "lb_updated_at_idx" ON "leaderboard_snapshots" USING btree ("updated_at");
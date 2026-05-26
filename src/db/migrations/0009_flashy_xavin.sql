ALTER TABLE "leaderboard_snapshots" ADD COLUMN "last_update_slot" bigint;--> statement-breakpoint
CREATE INDEX "lb_last_update_slot_idx" ON "leaderboard_snapshots" USING btree ("last_update_slot");
import { bigint, index, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const actionOutcomeEnum = pgEnum("action_outcome", ["success", "error"]);

export const actionLogs = pgTable(
  "action_logs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    command: text("command").notNull(),
    args: jsonb("args").$type<Record<string, unknown> | null>(),
    outcome: actionOutcomeEnum("outcome").notNull(),
    errorCode: text("error_code"),
    errorCategory: text("error_category"),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
    txSignature: text("tx_signature"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("action_logs_user_idx").on(t.userId, t.createdAt),
    cmdIdx: index("action_logs_cmd_idx").on(t.command, t.createdAt),
  }),
);

export type ActionLog = typeof actionLogs.$inferSelect;
export type NewActionLog = typeof actionLogs.$inferInsert;

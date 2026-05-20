import { eq } from "drizzle-orm";
import type { NextFunction } from "grammy";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

export async function authMiddleware(ctx: BotContext, next: NextFunction) {
  if (!ctx.from) return next();

  const user = await db.query.users.findFirst({
    where: eq(users.telegramId, String(ctx.from.id)),
  });

  if (user) {
    ctx.user = user;
  }

  return next();
}

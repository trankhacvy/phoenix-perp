import { eq } from "drizzle-orm";
import type { NextFunction } from "grammy";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";
import { initTestSigner } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";

export async function authMiddleware(ctx: BotContext, next: NextFunction) {
  if (!ctx.from) return next();

  const telegramId = String(ctx.from.id);

  let user = await db.query.users.findFirst({
    where: eq(users.telegramId, telegramId),
  });

  /* === DEV ONLY — remove this block before production === */
  if (!user && config.TEST_KEYPAIR) {
    const walletAddress = await initTestSigner();
    const [inserted] = await db
      .insert(users)
      .values({
        id: telegramId,
        telegramId,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        privyUserId: "test_privy_id",
        walletAddress,
        phoenixActivated: true,
        referralCode: `TEST${telegramId.slice(-4)}`,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { walletAddress, updatedAt: new Date() },
      })
      .returning();
    user = inserted;
  }
  /* === END DEV ONLY === */

  if (user) ctx.user = user;

  return next();
}

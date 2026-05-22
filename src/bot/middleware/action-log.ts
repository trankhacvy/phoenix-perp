import type { NextFunction } from "grammy";
import { writeActionLog } from "../../services/action-log.js";
import type { BotContext } from "../../types/index.js";
import { toBotError } from "../lib/errors.js";

function deriveCommand(ctx: BotContext): { command: string; args: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};

  const text = ctx.message?.text;
  if (text?.startsWith("/")) {
    const [head, ...rest] = text.split(/\s+/);
    const command = head.slice(1).split("@")[0];
    if (rest.length) args.raw = rest.join(" ");
    return { command, args };
  }

  const cbData = ctx.callbackQuery?.data;
  if (cbData) {
    const head = cbData.split(":")[0];
    args.data = cbData;
    return { command: `cb:${head}`, args };
  }

  if (text) {
    args.raw = text;
    return { command: "text", args };
  }

  return null;
}

export async function actionLogMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const derived = deriveCommand(ctx);
  if (!derived) {
    return next();
  }

  const start = Date.now();
  const { command, args } = derived;

  try {
    await next();
    const hint = ctx.actionLog;
    if (hint?.skip) return;
    if (hint?.outcome === "error") {
      await writeActionLog({
        userId: ctx.user?.id,
        command,
        args,
        outcome: "error",
        errorCode: hint.errorCode,
        errorCategory: hint.errorCategory,
        durationMs: Date.now() - start,
      });
      return;
    }
    await writeActionLog({
      userId: ctx.user?.id,
      command,
      args,
      outcome: "success",
      durationMs: Date.now() - start,
      txSignature: hint?.txSignature,
    });
  } catch (err) {
    const be = toBotError(err);
    await writeActionLog({
      userId: ctx.user?.id,
      command,
      args,
      outcome: "error",
      errorCode: be.code,
      errorCategory: be.category,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

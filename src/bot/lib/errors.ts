import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import type { BotContext } from "../../types/index.js";

export type ErrorCategory =
  | "validation"
  | "auth"
  | "config"
  | "api"
  | "network"
  | "ratelimit"
  | "tx_failed"
  | "io"
  | "gate"
  | "internal";

export type ErrorCode =
  | "INVALID_INPUT"
  | "SIZE_TOO_SMALL"
  | "LEV_OUT_OF_RANGE"
  | "UNKNOWN_MARKET"
  | "NOT_REGISTERED"
  | "NO_WALLET"
  | "PHOENIX_NOT_ACTIVATED"
  | "INSUFFICIENT_MARGIN"
  | "ISOLATED_ONLY_MARKET"
  | "TIER_OVERFLOW"
  | "PRICE_DRIFT"
  | "NO_POSITION"
  | "MARKET_CLOSED"
  | "BLOCKHASH_EXPIRED"
  | "INSUFFICIENT_SOL"
  | "SLIPPAGE_EXCEEDED"
  | "TX_REVERTED"
  | "RATE_LIMIT"
  | "NETWORK"
  | "UNKNOWN";

export interface BotErrorOpts {
  category: ErrorCategory;
  code: ErrorCode;
  userMessage: string;
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
  meta?: Record<string, unknown>;
}

export class BotError extends Error {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly meta?: Record<string, unknown>;

  constructor(opts: BotErrorOpts) {
    super(opts.userMessage);
    this.category = opts.category;
    this.code = opts.code;
    this.userMessage = opts.userMessage;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? false;
    this.meta = opts.meta;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
    this.name = "BotError";
  }
}

export function isBotError(e: unknown): e is BotError {
  return e instanceof BotError;
}

interface SdkPattern {
  match: RegExp;
  category: ErrorCategory;
  code: ErrorCode;
  userMessage: string;
  hint: string;
  retryable: boolean;
}

const SDK_PATTERNS: SdkPattern[] = [
  {
    match: /isolated[- ]only|isolated margin required/i,
    category: "validation",
    code: "ISOLATED_ONLY_MARKET",
    userMessage: "This market requires isolated margin.",
    hint: "Isolated margin support coming soon.",
    retryable: false,
  },
  {
    match:
      /insufficient (sol|lamports) for (gas|fees?)|insufficient lamports|out of (sol|lamports)|InsufficientFundsForRent|insufficient funds for rent/i,
    category: "tx_failed",
    code: "INSUFFICIENT_SOL",
    userMessage: "Not enough SOL for transaction fees.",
    hint: "Send at least 0.01 SOL to your bot wallet to cover gas.",
    retryable: false,
  },
  {
    match:
      /insufficient (margin|collateral)|not enough (margin|collateral)|exceeds available (margin|collateral)/i,
    category: "validation",
    code: "INSUFFICIENT_MARGIN",
    userMessage: "Insufficient margin.",
    hint: "Deposit more USDC with /deposit.",
    retryable: false,
  },
  {
    match: /trader (account )?not (found|registered)|no trader account/i,
    category: "auth",
    code: "NOT_REGISTERED",
    userMessage: "Account not registered.",
    hint: "Run /start to set up your account.",
    retryable: false,
  },
  {
    match: /(no open position|position not found|no position for)/i,
    category: "validation",
    code: "NO_POSITION",
    userMessage: "No open position found.",
    hint: "Check /positions.",
    retryable: false,
  },
  {
    match: /slippage|price moved|exceeded price|exceeded.*price.*tolerance/i,
    category: "tx_failed",
    code: "SLIPPAGE_EXCEEDED",
    userMessage: "Price moved past your slippage limit.",
    hint: "Tap Refresh to requote, then retry.",
    retryable: true,
  },
  {
    match:
      /blockhash not found|block height exceeded|TransactionExpiredBlockheightExceededError|TransactionExpiredTimeoutError/,
    category: "tx_failed",
    code: "BLOCKHASH_EXPIRED",
    userMessage: "Transaction expired.",
    hint: "Safe to retry immediately.",
    retryable: true,
  },
  {
    match: /\b(rate[- ]?limit(ed|ing)?|too many requests|HTTP 429|status (code )?429)\b/i,
    category: "ratelimit",
    code: "RATE_LIMIT",
    userMessage: "API rate limit hit.",
    hint: "Wait a few seconds and try again.",
    retryable: true,
  },
  {
    match:
      /(bad gateway|gateway timeout|service unavailable|internal server error|HTTP 50[234])|telegram.*5\d\d/i,
    category: "network",
    code: "NETWORK",
    userMessage: "Upstream service is unavailable.",
    hint: "Retrying automatically.",
    retryable: true,
  },
  {
    match:
      /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network (error|timeout|unreachable))\b/i,
    category: "network",
    code: "NETWORK",
    userMessage: "Network error.",
    hint: "Check your connection and try again.",
    retryable: true,
  },
];

export function toBotError(err: unknown): BotError {
  if (isBotError(err)) return err;
  const msg = err instanceof Error ? err.message : String(err);
  for (const p of SDK_PATTERNS) {
    if (p.match.test(msg)) {
      return new BotError({
        category: p.category,
        code: p.code,
        userMessage: p.userMessage,
        hint: p.hint,
        retryable: p.retryable,
        cause: err,
      });
    }
  }
  return new BotError({
    category: "internal",
    code: "UNKNOWN",
    userMessage: "Something went wrong.",
    hint: "Try again, or /help if it keeps happening.",
    retryable: false,
    cause: err,
  });
}

export interface RenderBotErrorOpts {
  action?: string;
  edit?: boolean;
  replyMarkup?: InlineKeyboard;
}

export async function renderBotError(
  ctx: BotContext,
  err: unknown,
  opts: RenderBotErrorOpts = {},
): Promise<void> {
  const be = toBotError(err);
  logger.error(
    {
      code: be.code,
      category: be.category,
      retryable: be.retryable,
      meta: be.meta,
      cause: be.cause,
    },
    "BotError",
  );

  const header = opts.action ? `❌ ${opts.action} failed` : "❌ Error";
  const retryLine = be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``;
  const hintLine = be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``;
  const msg = fmt`${FormattedString.b(header)}\n\n${be.userMessage}${hintLine}${retryLine}`;

  try {
    if (opts.edit && ctx.callbackQuery) {
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        reply_markup: opts.replyMarkup,
      });
    } else {
      await ctx.reply(msg.text, {
        entities: msg.entities,
        reply_markup: opts.replyMarkup,
      });
    }
  } catch (renderErr) {
    logger.warn({ renderErr }, "Failed to send BotError to user");
  }
}

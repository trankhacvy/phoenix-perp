export interface TradeErrorInfo {
  message: string;
  hint: string;
  retryable: boolean;
}

const PATTERNS: Array<{ match: RegExp; info: TradeErrorInfo }> = [
  {
    match: /blockhash not found|block height exceeded|expired/i,
    info: {
      message: "Transaction expired.",
      hint: "It's safe to retry immediately.",
      retryable: true,
    },
  },
  {
    match: /insufficient.*sol|0x1\b/i,
    info: {
      message: "Not enough SOL for gas.",
      hint: "Top up your wallet with a small amount of SOL.",
      retryable: false,
    },
  },
  {
    match: /insufficient.*collateral|not enough margin|exceeds.*available/i,
    info: {
      message: "Insufficient margin.",
      hint: "Deposit more USDC with /deposit.",
      retryable: false,
    },
  },
  {
    match: /trader.*not.*found|no trader account|account.*not.*register/i,
    info: {
      message: "Account not registered.",
      hint: "Run /start to set up your account.",
      retryable: false,
    },
  },
  {
    match: /slippage|price.*moved|exceeded.*price/i,
    info: {
      message: "Price moved too fast.",
      hint: "The market moved. Try again.",
      retryable: true,
    },
  },
  {
    match: /position.*not found|no.*position|no open position/i,
    info: {
      message: "No open position found.",
      hint: "Check /positions.",
      retryable: false,
    },
  },
  {
    match: /isolated.*only|isolated margin required/i,
    info: {
      message: "This market requires isolated margin.",
      hint: "Isolated margin support coming soon.",
      retryable: false,
    },
  },
  {
    match: /rate.?limit|429/i,
    info: {
      message: "API rate limit hit.",
      hint: "Wait a few seconds and try again.",
      retryable: true,
    },
  },
  {
    match: /network|ECONNRESET|ETIMEDOUT|fetch failed/i,
    info: {
      message: "Network error.",
      hint: "Check your connection and try again.",
      retryable: true,
    },
  },
];

export function classifyTradeError(err: unknown): TradeErrorInfo {
  const msg = err instanceof Error ? err.message : String(err);
  for (const { match, info } of PATTERNS) {
    if (match.test(msg)) return info;
  }
  return {
    message: "Something went wrong.",
    hint: "Try again or contact support if this keeps happening.",
    retryable: false,
  };
}

export function formatTradeError(err: unknown, action: string): string {
  const { message, hint, retryable } = classifyTradeError(err);
  const retryNote = retryable ? "\n\n↩️ This is safe to retry." : "";
  return `❌ <b>${action} failed</b>\n\n${message}\n<i>${hint}</i>${retryNote}`;
}

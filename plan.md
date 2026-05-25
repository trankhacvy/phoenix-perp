# SuperNova Production Deployment Plan

## Overview

This plan covers every change needed to ship the bot to production. Organized into 7 phases, each with exact file paths, line numbers, and code snippets.

---

## Phase 1: grammY Infrastructure (P0 — blocking launch)

### 1.1 Install `auto-retry` plugin

Handles Telegram 429 rate limits automatically. Critical for alert bursts.

```bash
pnpm add @grammyjs/auto-retry
```

**File: `src/bot/index.ts`** — add after bot creation (line 29):

```typescript
import { autoRetry } from "@grammyjs/auto-retry";

export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

bot.api.config.use(
  autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 15,
  }),
);
```

This also protects the alert worker's `bot.api.sendMessage` calls in `src/jobs/processors/alert.ts` since they share the same `bot.api` instance.

---

### 1.2 Webhook secret token

Prevents anyone from POSTing fake updates to your webhook endpoint.

**File: `src/config/index.ts`** — add to Zod schema:

```typescript
WEBHOOK_SECRET: z.string().min(16).optional(),
```

**File: `src/main.ts`** — update webhook setup (lines 53-54):

```typescript
const webhookUrl = `${config.WEBHOOK_URL}/webhook/${config.TELEGRAM_BOT_TOKEN}`;
await bot.api.setWebhook(webhookUrl, {
  secret_token: config.WEBHOOK_SECRET,
  drop_pending_updates: true,   // don't process stale updates on deploy
});
```

**File: `src/server/index.ts`** — validate secret header:

```typescript
export async function createServer() {
  const app = fastify({ logger: false });

  await app.register(cors);
  await app.register(healthRoutes);

  app.post(`/webhook/${config.TELEGRAM_BOT_TOKEN}`, async (req, reply) => {
    if (config.WEBHOOK_SECRET) {
      const token = req.headers["x-telegram-bot-api-secret-token"];
      if (token !== config.WEBHOOK_SECRET) {
        return reply.code(401).send("Unauthorized");
      }
    }
    return handleWebhook()(req, reply);
  });

  return app;
}
```

---

### 1.3 Improve `bot.catch` handler

Current handler at `src/bot/index.ts:245-252` already exists and is good. But it should differentiate `GrammyError` vs `HttpError` for better logging:

```typescript
import { GrammyError, HttpError } from "grammy";

bot.catch(async (err) => {
  const e = err.error;
  if (e instanceof GrammyError) {
    logger.error({ description: e.description, method: e.method, code: e.error_code }, "GrammyError");
  } else if (e instanceof HttpError) {
    logger.error({ err: e.error }, "HttpError — could not contact Telegram");
  } else {
    logger.error({ err: e, update: err.ctx.update }, "Bot error");
  }
  try {
    await renderBotError(err.ctx, e);
  } catch {
    // ctx may be invalid
  }
});
```

---

### 1.4 Callback query fallback

Prevents "loading..." spinner on stale/expired inline buttons.

**File: `src/bot/index.ts`** — add AFTER `bot.on("message:text")` handler (after line 243), BEFORE `bot.catch`:

```typescript
bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
});
```

This catches any callback that doesn't match a registered handler.

---

### 1.5 `sequentialize` middleware

Prevents race conditions when user taps two buttons fast (both read same pending state, both try to execute).

```bash
pnpm add @grammyjs/runner
```

**File: `src/bot/index.ts`** — add BEFORE auth middleware (line 31):

```typescript
import { sequentialize } from "@grammyjs/runner";

function getSessionKey(ctx: BotContext): string | undefined {
  return ctx.from?.id.toString();
}

bot.use(sequentialize(getSessionKey));

bot.use(authMiddleware);
bot.use(actionLogMiddleware);
bot.use(rateLimitMiddleware);
```

This serializes updates per user — two rapid taps from the same user are processed sequentially. Different users stay concurrent.

---

### 1.6 Trade execution timeout — the critical webhook issue

**Problem**: `placeMarketOrder` → `dispatchInstruction` → `pollConfirmation` loops for up to 120s. Webhook expects response in ~30s. Telegram retries = duplicate trade.

**Solution**: Don't block the callback handler. Respond immediately, execute async, edit message when done.

**File: `src/bot/commands/long.ts`** — refactor the confirm callback (lines 132-221):

```typescript
bot.callbackQuery(/^confirm:long:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Opening…");
  if (!ctx.user) return;
  if (!(await checkOrderRateLimit(ctx))) return;

  const [symbol, leverageStr, sizeStr, anchorStr] = ctx.match.slice(1);
  const lev = Number(leverageStr);
  const sizeUsdc = Number(sizeStr);
  const anchorPrice = Number(anchorStr);

  // Idempotency: prevent duplicate execution from webhook retries
  const idempKey = `trade:idem:${ctx.from.id}:${ctx.callbackQuery.id}`;
  const first = await redis.set(idempKey, "1", "EX", 120, "NX");
  if (!first) return;

  // Preflight — fast, OK to block
  let pf: PreflightResult;
  try {
    pf = await preflightOpen({
      user: ctx.user,
      symbol,
      side: "long",
      marginUsdc: sizeUsdc,
      leverage: lev,
      anchorPrice,
    });
  } catch (e) {
    const be = toBotError(e);
    ctx.actionLog = { outcome: "error", errorCode: be.code, errorCategory: be.category };
    if (be.code === "PRICE_DRIFT") {
      const kb = new InlineKeyboard()
        .text("🔄 Refresh price", `trade_refresh:long:${symbol}:${lev}:${sizeUsdc}`)
        .row()
        .text("✕ Cancel", "cancel");
      await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
      return;
    }
    const kb = new InlineKeyboard()
      .text("← Resize", `trade:long:${symbol}`)
      .text("✕ Cancel", "cancel");
    await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
    return;
  }

  // Show "submitting" state immediately — don't wait for on-chain
  await ctx.editMessageText("⏳ Submitting order to Solana…");

  // Fire-and-forget the on-chain execution, edit message when done
  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery.message?.message_id;

  (async () => {
    try {
      const baseUnits = marginToTokens(
        pf.snapshot, sizeUsdc, pf.effectiveLeverage,
        anchorPrice > 0 ? anchorPrice : undefined,
      );
      const sig = await trackAction(
        {
          userId: user.id,
          command: "trade.long",
          args: { symbol, leverage: pf.effectiveLeverage, marginUsdc: sizeUsdc, notional: pf.notional },
        },
        () => placeMarketOrder({ symbol, side: "long", baseUnits, walletAddress: user.walletAddress }),
      );
      await subscribeUser(user.walletAddress, user.telegramId);

      const tokenSize = pf.notional / pf.snapshot.markPrice;
      const kb = new InlineKeyboard()
        .text("🛑 Set SL", `editsl:${symbol}:long`)
        .text("🎯 Set TP", `edittp:${symbol}:long`)
        .row()
        .text("📊 View position", "nav:positions");

      const msg = fmt`✅ ${FormattedString.b(`Long ${usd(pf.notional, 0, 0)} of ${symbol} opened`)}\n\nEntry:     ~${FormattedString.b(fmtPrice(pf.snapshot.markPrice))}\nSize:      ~${FormattedString.b(`${num(tokenSize, 2, 4)} ${symbol}`)}\nFee paid:  ${FormattedString.b(usd(pf.feeUsdc))}\nLiq price: ~${FormattedString.b(fmtPrice(pf.liqPrice))}\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;

      if (chatId && msgId) {
        await bot.api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          reply_markup: kb,
          link_preview_options: { is_disabled: true },
        });
      }
    } catch (e) {
      logger.error({ err: e, symbol, side: "long" }, "placeMarketOrder failed");
      if (chatId && msgId) {
        const errMsg = toBotError(e);
        const kb = new InlineKeyboard()
          .text("Try again", `trade:long:${symbol}`)
          .text("← Back", "nav:positions");
        try {
          await bot.api.editMessageText(chatId, msgId,
            `❌ Trade failed\n\n${errMsg.userMessage}\n${errMsg.hint ?? ""}`,
            { reply_markup: kb },
          );
        } catch { /* message may have been deleted */ }
      }
    }
  })();
});
```

Same refactor needed for `short.ts`, `positions.ts` (close execution), `withdraw.ts` (exec callbacks), and `setsl.ts`/`settp.ts` (set TP/SL execution).

The pattern is:
1. Answer callback query immediately
2. Edit message to "⏳ Processing…" 
3. Capture `chatId` + `msgId` from context
4. Execute on-chain work in async IIFE
5. Edit message with result using `bot.api.editMessageText(chatId, msgId, ...)` instead of `ctx.editMessageText`

---

### 1.7 Idempotency guard for all trade executions

Add to every on-chain execution callback to prevent webhook-retry duplicates.

**Helper in `src/bot/lib/idempotent.ts`** (new file):

```typescript
import { redis } from "../../lib/redis.js";

export async function claimIdempotencyKey(
  userId: number | string,
  callbackId: string,
  ttlSeconds = 120,
): Promise<boolean> {
  const key = `idem:${userId}:${callbackId}`;
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return result !== null;
}
```

Use in every confirm callback:

```typescript
if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) {
  await ctx.answerCallbackQuery("Already processing…");
  return;
}
```

---

### 1.8 Graceful shutdown — add SIGINT

**File: `src/main.ts`** — lines 69-76, add SIGINT handler:

```typescript
async function shutdown() {
  logger.info("Shutting down…");
  await bot.stop();
  if (server) await server.close();
  stopWsManager();
  await Promise.all([stopAlertWorker(), stopLeaderboardScanner()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

---

### 1.9 Set bot commands on startup

**File: `src/main.ts`** — add after bot starts (inside `main()`, before the if/else block):

```typescript
await bot.api.setMyCommands([
  { command: "start", description: "Create wallet & get started" },
  { command: "portfolio", description: "Full account overview" },
  { command: "long", description: "Open a long position" },
  { command: "short", description: "Open a short position" },
  { command: "positions", description: "View open positions" },
  { command: "markets", description: "Browse all markets" },
  { command: "deposit", description: "Add USDC to your account" },
  { command: "withdraw", description: "Move funds out" },
  { command: "history", description: "Trade history with P&L" },
  { command: "alerts", description: "Toggle alert types" },
  { command: "settings", description: "Slippage & leverage defaults" },
  { command: "referral", description: "Your referral link & stats" },
  { command: "funding", description: "Top funding rates" },
  { command: "leaderboard", description: "Top traders" },
  { command: "help", description: "All commands & help" },
]);

await bot.api.setMyDescription("Trade perpetual futures on Phoenix — directly from Telegram. ⚡");
await bot.api.setMyShortDescription("Phoenix perps trading bot on Solana");
```

---

## Phase 2: Branding — PhoenixPerpBot → SuperNova

### 2.1 Four code locations to update

**File: `src/bot/commands/help.ts:6`**
```typescript
// Before:
const HEADER = fmt`🔥 ${FormattedString.b("PhoenixPerpBot")}
// After:
const HEADER = fmt`🔥 ${FormattedString.b("SuperNova")}
```

**File: `src/bot/commands/start.ts:180`**
```typescript
// Before:
const msg = fmt`🔥 ${FormattedString.b("Welcome to PhoenixPerpBot!")}
// After:
const msg = fmt`🔥 ${FormattedString.b("Welcome to SuperNova!")}
```

**File: `src/bot/commands/activate.ts:6`**
```typescript
// Before:
const INVITE_SEARCH_URL = "https://x.com/search?q=%23PhoenixPerp+invite";
// After:
const INVITE_SEARCH_URL = "https://x.com/search?q=%23SuperNova+invite";
```

**File: `src/bot/lib/activation.ts:4`**
```typescript
// Before:
const INVITE_SEARCH_URL = "https://x.com/search?q=%23PhoenixPerp+invite";
// After:
const INVITE_SEARCH_URL = "https://x.com/search?q=%23SuperNova+invite";
```

### 2.2 Package metadata

**File: `package.json:2`**
```json
"name": "supernova-bot",
```

### 2.3 Bot description (already covered in 1.9)

`setMyDescription` and `setMyShortDescription` — update text to say "SuperNova" instead of any Phoenix references.

### 2.4 P&L card watermark

**File: `src/services/image.ts`** — search for any hardcoded branding text in the Satori JSX. If "PhoenixPerpBot" or similar watermark exists, replace with "SuperNova".

---

## Phase 3: Beta Disclaimer

### 3.1 `/start` welcome message

**File: `src/bot/commands/start.ts:180`** — append to the new user welcome:

```typescript
const msg = fmt`🔥 ${FormattedString.b("Welcome to SuperNova!")}

${FormattedString.b("Your wallet:")}
${FormattedString.code(walletAddress)}

Deposit USDC to fund your account.

⚠️ ${FormattedString.b("Activate trading:")}
Use /activate <code> with your Phoenix invite or referral code to unlock trading.

${FormattedString.i("⚠️ SuperNova is in beta. Trade at your own risk. Perpetual futures involve significant risk of loss.")}`;
```

### 3.2 `/start` returning user (activated)

**File: `src/bot/commands/start.ts:129`** — append to the returning-user message:

```typescript
const msg = fmt`🔥 ${FormattedString.b(`Welcome back, ${name}!`)}

💰 ${FormattedString.b("Wallet Balance")}
${FormattedString.b(`${sol.toFixed(4)} SOL`)}${solPrice > 0 ? fmt`  (${FormattedString.b(usd(solUsd))})` : fmt``}

${FormattedString.code(ctx.user.walletAddress)}

Deposit USDC to fund your account and start trading.

${FormattedString.i("⚠️ Beta — trade at your own risk.")}`;
```

### 3.3 `/help` header

**File: `src/bot/commands/help.ts:6-11`** — append beta note:

```typescript
const HEADER = fmt`🔥 ${FormattedString.b("SuperNova")}

Trade perpetual futures on ${FormattedString.link("Phoenix", "https://www.phoenix.trade")} — directly from Telegram.
Long, short, set TP/SL, track P&L, follow top traders.

${FormattedString.i("⚠️ Beta — trade at your own risk.")}

What can I help with?`;
```

---

## Phase 4: Remove standalone `/settp` and `/setsl` commands

Users access TP/SL from position detail buttons only. The functions stay — only command registration is removed.

### 4.1 Comment out command registration

**File: `src/bot/commands/index.ts`** — lines 49-50:

```typescript
// registerSetSl(bot);    // accessible from position detail → "Set SL" button
// registerSetTp(bot);    // accessible from position detail → "Set TP" button
```

### 4.2 Remove from help

**File: `src/bot/commands/help.ts`** — remove these lines from the Trading category (lines 34-35):

```typescript
// Before:
content: fmt`📈 ${FormattedString.b("Trading")}

/long — Open a long position
/short — Open a short position
/positions — View & manage open positions
/setsl — Set stop loss
/settp — Set take profit
/markets — Browse all markets
/market <symbol> — Market detail + technicals`,

// After:
content: fmt`📈 ${FormattedString.b("Trading")}

/long — Open a long position
/short — Open a short position
/positions — View & manage open positions
/markets — Browse all markets
/market <symbol> — Market detail + technicals`,
```

### 4.3 Remove from `setMyCommands` (Phase 1.9)

They were never in the command list. No action needed.

### 4.4 Keep the callback handlers

The `editsl:` and `edittp:` callbacks in `positions.ts:399-411` still work. The `sendSlPrompt` / `sendTpPrompt` functions in `setsl.ts` / `settp.ts` stay exported and callable. The pending-state handlers in `bot/index.ts` (lines 161-230) for `editsl` / `edittp` stay unchanged.

---

## Phase 5: UX / Wording Fixes

### 5.1 Referral tier labels — "T1/T2" → "Direct/Indirect"

**File: `src/bot/commands/referral.ts:22`**

```typescript
// Before:
const msg = fmt`... T1 referrals: ... T2 referrals: ...`;

// After:
const msg = fmt`👥 ${FormattedString.b("Your Referral")}

Link: ${link}
Code: ${FormattedString.code(ctx.user.referralCode)}

Direct referrals: ${FormattedString.b(String(stats.t1Count))}
Indirect referrals: ${FormattedString.b(String(stats.t2Count))}

Accrued rebate: ${FormattedString.code(`${stats.totalAccruedUsdc.toFixed(6)} USDC`)}
Claimable: ${FormattedString.code(`${stats.claimableUsdc.toFixed(6)} USDC`)}

Use /claim to withdraw your rebate.`;
```

---

### 5.2 "All safe" button → "Max safe ($X)"

**File: `src/bot/commands/withdraw.ts:135`**

```typescript
// Before:
const btnLabel = p === 100 ? "All safe" : `${p}%`;

// After:
const btnLabel = p === 100 ? "Max safe" : `${p}%`;
```

---

### 5.3 "Type /start first." → friendlier wording

Global search-and-replace across all command files:

```typescript
// Before:
await ctx.reply("Type /start first.");

// After:
await ctx.reply("Please run /start first to set up your account.");
```

**Files to update:**
- `src/bot/commands/long.ts:35`
- `src/bot/commands/short.ts` (same pattern)
- `src/bot/commands/positions.ts:211`
- `src/bot/commands/deposit.ts:17`
- `src/bot/commands/withdraw.ts:283`
- `src/bot/commands/settings.ts:59`
- `src/bot/commands/alerts.ts:46`
- `src/bot/commands/portfolio.ts` (wherever present)
- `src/bot/commands/history.ts` (wherever present)

---

### 5.4 "Orders may cancel" → "Margin warning"

**File: `src/bot/commands/alerts.ts:12`**

```typescript
// Before:
{ type: "cancellable", label: "Orders may cancel", default: true },

// After:
{ type: "cancellable", label: "Margin warning", default: true },
```

---

### 5.5 "Est. P&L" → add "(excl. fees)"

**File: `src/bot/commands/positions.ts:278`**

```typescript
// Before:
Est. P&L:    ${FormattedString.b(signedUsd(estimatedPnl))}

// After:
Est. P&L:    ${FormattedString.b(signedUsd(estimatedPnl))} ${FormattedString.i("(excl. fees)")}
```

---

### 5.6 Activation failure — more context

**File: `src/bot/commands/activate.ts:87`**

```typescript
// Before:
await ctx.api.editMessageText(chatId, msgId, "❌ Activation failed. Please try again.");

// After:
await ctx.api.editMessageText(chatId, msgId, "❌ Activation failed — the code may be invalid or expired. Try a different code.");
```

---

### 5.7 "Move it into your trading account" — clarify "it"

**File: `src/bot/commands/deposit.ts:161`**

```typescript
// Before:
Move it into your trading account to start trading.

// After:
Move your USDC into your trading account to start trading.
```

---

### 5.8 New user welcome — mention wallet creation

**File: `src/bot/commands/start.ts:180`** — update welcome message:

```typescript
const msg = fmt`🔥 ${FormattedString.b("Welcome to SuperNova!")}

We created a Solana wallet for you:
${FormattedString.code(walletAddress)}

Deposit USDC to fund your account.

⚠️ ${FormattedString.b("Activate trading:")}
Use /activate <code> with your Phoenix invite or referral code to unlock trading.

${FormattedString.i("⚠️ SuperNova is in beta. Trade at your own risk. Perpetual futures involve significant risk of loss.")}`;
```

---

### 5.9 Leaderboard empty state — better message

**File: `src/bot/commands/leaderboard.ts`** — find the empty-state text:

```typescript
// Before:
"No trader data available yet."

// After:
"Leaderboard is loading — check back in a few minutes."
```

---

### 5.10 Funding empty state

**File: `src/bot/commands/funding.ts`** — find the empty-state text:

```typescript
// Before:
"No significant funding rates right now."

// After:
"All funding rates are near zero right now."
```

---

## Phase 6: Health check improvements

### 6.1 Add Redis + DB connectivity to health endpoint

**File: `src/server/routes/health.ts`**

```typescript
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { redis } from "../../lib/redis.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, string> = {};

    try {
      await db.execute(sql`SELECT 1`);
      checks.db = "ok";
    } catch {
      checks.db = "error";
    }

    try {
      await redis.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    }

    const healthy = checks.db === "ok" && checks.redis === "ok";
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    });
  });
}
```

---

## Phase 7: Known bug fixes

### 7.1 Alert toggle missing `type` filter — ALREADY FIXED

Looking at `src/bot/commands/alerts.ts:58-63`, the current code correctly includes the type filter via `eq(alertSubscriptions.type, type)` AND `isNull(alertSubscriptions.symbol)`. The bug noted in CLAUDE.md appears to be already resolved.

### 7.2 Referral T2 chain lookup bug

**File: `src/services/referral.ts`** — in `linkReferral`, the T2 lookup must filter by `tier = "t1"` to prevent picking a T2 row as the parent:

```typescript
// Find T2 parent — the person who referred our referrer
const t2Parent = await db.query.referrals.findFirst({
  where: and(
    eq(referrals.refereeId, referrer.id),
    eq(referrals.tier, "t1"),  // <-- ADD THIS FILTER
  ),
});
```

### 7.3 `replyWithPhoto` with `Uint8Array`

Already fixed in `positions.ts:353` — it correctly uses `new InputFile(card, "pnl.png")`. Check `share.ts` and `deposit.ts` for same pattern. Deposit already uses `new InputFile(qr, "deposit-qr.png")` at line 118. Verify `share.ts`.

---

## Implementation Order

| Priority | Phase | Estimated effort |
|----------|-------|-----------------|
| **P0** | 1.1 auto-retry plugin | 10 min |
| **P0** | 1.2 webhook secret | 20 min |
| **P0** | 1.6 trade execution timeout fix | 2-3 hours |
| **P0** | 1.7 idempotency guard | 30 min |
| **P1** | 1.3 improve bot.catch | 10 min |
| **P1** | 1.4 callback query fallback | 5 min |
| **P1** | 1.5 sequentialize middleware | 15 min |
| **P1** | 1.8 graceful shutdown SIGINT | 5 min |
| **P1** | 1.9 setMyCommands | 10 min |
| **P1** | 2.x branding (all 4 locations + package.json) | 15 min |
| **P1** | 3.x beta disclaimer (3 locations) | 10 min |
| **P1** | 4.x remove standalone settp/setsl | 10 min |
| **P2** | 5.x UX wording fixes (10 items) | 30 min |
| **P2** | 6.1 health check improvements | 15 min |
| **P2** | 7.x bug fixes | 20 min |
| | **Total** | **~5-6 hours** |

---

## New dependencies

```bash
pnpm add @grammyjs/auto-retry @grammyjs/runner
```

---

## Files touched (summary)

| File | Changes |
|------|---------|
| `package.json` | name, new deps |
| `src/config/index.ts` | WEBHOOK_SECRET env var |
| `src/main.ts` | webhook secret, setMyCommands, SIGINT, drop_pending_updates |
| `src/server/index.ts` | webhook secret validation |
| `src/server/routes/health.ts` | DB + Redis checks |
| `src/bot/index.ts` | auto-retry, sequentialize, callback fallback, bot.catch improvement |
| `src/bot/lib/idempotent.ts` | NEW — idempotency helper |
| `src/bot/commands/index.ts` | comment out registerSetSl/registerSetTp |
| `src/bot/commands/start.ts` | branding, beta disclaimer, wallet creation note |
| `src/bot/commands/help.ts` | branding, beta disclaimer, remove /setsl /settp |
| `src/bot/commands/long.ts` | async trade execution, idempotency |
| `src/bot/commands/short.ts` | same as long.ts |
| `src/bot/commands/positions.ts` | async close execution, "excl. fees" note |
| `src/bot/commands/withdraw.ts` | "Max safe" button label |
| `src/bot/commands/activate.ts` | branding, error message improvement |
| `src/bot/commands/alerts.ts` | "Margin warning" label |
| `src/bot/commands/referral.ts` | "Direct/Indirect" tier labels |
| `src/bot/commands/deposit.ts` | wording clarity |
| `src/bot/commands/leaderboard.ts` | empty state wording |
| `src/bot/commands/funding.ts` | empty state wording |
| `src/bot/commands/settings.ts` | "run /start first" wording |
| `src/bot/lib/activation.ts` | branding URL |
| `src/services/referral.ts` | T2 lookup bug fix |
| All command files | "Type /start first" → "Please run /start first to set up your account" |

---

## Post-deploy verification

1. Send `/start` to bot — confirm "SuperNova" branding + beta disclaimer
2. Send `/help` — confirm branding + no /setsl or /settp listed
3. Open a test trade — confirm async execution (message shows "⏳ Submitting…" then updates)
4. Tap a stale button — confirm no loading spinner (callback fallback)
5. Check `/health` endpoint — confirm DB + Redis status
6. Send 10+ rapid button taps — confirm sequentialize prevents race conditions
7. Check logs for `GrammyError` / `HttpError` classification
8. Verify webhook secret by curling without header → 401

---

## TODO Checklist

### Phase 1: grammY Infrastructure (P0)

- [x] **1.0** Install new dependencies
  - [x] `pnpm add @grammyjs/auto-retry`
  - [x] `pnpm add @grammyjs/runner`
  - [x] Run `pnpm build` to verify no type errors

- [x] **1.1** Auto-retry plugin
  - [x] Import `autoRetry` in `src/bot/index.ts`
  - [x] Add `bot.api.config.use(autoRetry(...))` after bot creation
  - [x] Configure `maxRetryAttempts: 3`, `maxDelaySeconds: 15`

- [x] **1.2** Webhook secret token
  - [x] Add `WEBHOOK_SECRET` to Zod schema in `src/config/index.ts`
  - [x] Add `WEBHOOK_SECRET` to `.env.example`
  - [x] Update `setWebhook` call in `src/main.ts` to pass `secret_token` and `drop_pending_updates: true`
  - [x] Update `src/server/index.ts` to validate `x-telegram-bot-api-secret-token` header

- [x] **1.3** Improve `bot.catch` handler
  - [x] Import `GrammyError`, `HttpError` from `grammy` in `src/bot/index.ts`
  - [x] Replace catch handler with version that distinguishes GrammyError, HttpError, and unknown errors
  - [x] Log GrammyError with `description`, `method`, `error_code`
  - [x] Log HttpError with inner `error` property

- [x] **1.4** Callback query fallback
  - [x] Add `bot.on("callback_query:data", ...)` in `src/bot/index.ts` after `bot.on("message:text")` and before `bot.catch`
  - [x] Handler calls `ctx.answerCallbackQuery()` with no text

- [x] **1.5** Sequentialize middleware
  - [x] Import `sequentialize` from `@grammyjs/runner` in `src/bot/index.ts`
  - [x] Define `getSessionKey` function returning `ctx.from?.id.toString()`
  - [x] Add `bot.use(sequentialize(getSessionKey))` BEFORE auth middleware

- [x] **1.6** Async trade execution (webhook timeout fix)
  - [x] Create `src/bot/lib/idempotent.ts` with `claimIdempotencyKey` helper
  - [x] Refactor `long.ts` confirm callback — async IIFE + idempotency
  - [x] Refactor `short.ts` confirm callback — same pattern
  - [x] Refactor `positions.ts` close execution callback — async IIFE + idempotency
  - [x] Refactor `positions.ts` addMargin exec callback — async IIFE + idempotency
  - [x] Refactor `deposit.ts` confirm callback — async IIFE + idempotency
  - [x] Refactor `setsl.ts` sl:exec + sl:remove callbacks — async IIFE + idempotency
  - [x] Refactor `settp.ts` tp:exec + tp:remove callbacks — async IIFE + idempotency
  - [x] withdraw.ts — already has own lock mechanism, no change needed

- [x] **1.7** Idempotency guard — verified in all on-chain execution callbacks

- [x] **1.8** Graceful shutdown
  - [x] Refactored SIGTERM handler into named `shutdown()` function
  - [x] Added `process.on("SIGINT", shutdown)`

- [x] **1.9** Set bot commands on startup
  - [x] Added `bot.api.setMyCommands([...])` with 15 commands
  - [x] Added `bot.api.setMyDescription(...)` with SuperNova branding
  - [x] Added `bot.api.setMyShortDescription(...)` with SuperNova branding

### Phase 2: Branding (P1)

- [x] **2.1** `help.ts` — "PhoenixPerpBot" → "SuperNova"
- [x] **2.2** `start.ts` — "Welcome to PhoenixPerpBot!" → "Welcome to SuperNova!"
- [x] **2.3** `activate.ts` — `#PhoenixPerp+invite` → `#SuperNova+invite`
- [x] **2.4** `activation.ts` — `#PhoenixPerp+invite` → `#SuperNova+invite`
- [x] **2.5** `start.ts` returning user URL — `#PhoenixPerp+invite` → `#SuperNova+invite`
- [x] **2.6** `package.json` — `"phoenix-perp-bot"` → `"supernova-bot"`
- [x] **2.7** `setMyDescription`/`setMyShortDescription` — SuperNova branding
- [x] **2.8** P&L card (`image.ts`) — no old branding found, only internal comments
- [x] **2.9** Full grep — zero remaining "PhoenixPerp" or "phoenix-perp-bot" in src/

### Phase 3: Beta Disclaimer (P1)

- [x] **3.1** New user welcome — beta disclaimer + "We created a Solana wallet for you:"
- [x] **3.2** Returning activated user — "⚠️ Beta — trade at your own risk."
- [x] **3.3** Returning unactivated user — "⚠️ Beta — trade at your own risk."
- [x] **3.4** Help header — beta line added

### Phase 4: Remove Standalone /settp and /setsl (P1)

- [x] **4.1** Commented out `registerSetSl(bot)` and `registerSetTp(bot)` in `index.ts`
- [x] **4.2** Removed `/setsl` and `/settp` from help Trading category
- [x] **4.3** Verified callback handlers (`editsl:`, `edittp:`, pending-state) still work
- [x] **4.4** Updated COMMANDS.md — noted SL/TP accessed from position detail
- [x] Removed unused imports `registerSetSl` / `registerSetTp` from `index.ts`

### Phase 5: UX / Wording Fixes (P2)

- [x] **5.1** "T1/T2 referrals" → "Direct/Indirect referrals" in `referral.ts`
- [x] **5.2** "All safe" → "Max safe" in `withdraw.ts`
- [x] **5.3** "Type /start first." → "Please run /start first to set up your account." (14 files)
- [x] **5.3b** "Use /start first." → same (4 files: share, referral, claim, export)
- [x] **5.4** "Orders may cancel" → "Margin warning" in `alerts.ts`
- [x] **5.5** "Est. P&L:" → added "(excl. fees)" in `positions.ts`
- [x] **5.6** "Activation failed. Please try again." → "Activation failed — the code may be invalid or expired. Try a different code." in `activate.ts`
- [x] **5.7** "Move it into" → "Move your USDC into" in `deposit.ts`
- [x] **5.8** "Your wallet:" → "We created a Solana wallet for you:" (combined with 3.1)
- [x] **5.9** "No trader data available yet." → "Leaderboard is loading — check back in a few minutes." in `leaderboard.ts`
- [x] **5.10** "No significant funding rates right now." → "All funding rates are near zero right now." in `funding.ts`

### Phase 6: Health Check (P2)

- [x] **6.1** Upgraded health endpoint with DB `SELECT 1` + Redis `ping` checks, 200/503 response

### Phase 7: Bug Fixes (P2)

- [x] **7.1** Alert toggle bug — verified already fixed (has `type` filter + `isNull(symbol)`)
- [x] **7.2** Referral T2 chain lookup — verified already fixed (has `eq(referrals.tier, "t1")` filter)
- [x] **7.3** `replyWithPhoto` — verified all 3 callsites use `new InputFile(...)`
- [x] **7.4** Updated CLAUDE.md known bugs section — all 4 marked as fixed

### Final Checks

- [x] **F.1** Build verification
  - [x] `pnpm exec tsc --noEmit` — zero errors
  - [x] `pnpm check` — zero lint/format errors

- [x] **F.2** Test suite
  - [x] `pnpm test` — 75/75 tests pass
  - [x] No test files reference old branding

- [x] **F.3** Environment setup
  - [x] `.env.example` updated with `WEBHOOK_SECRET=`
  - [ ] Generate `WEBHOOK_SECRET` and add to Coolify env vars (deploy-time)

- [ ] **F.4** Deploy & verify (post-merge manual testing)
  - [ ] Push to main, wait for CI green
  - [ ] Verify Coolify deploys all 3 services
  - [ ] Send `/start` — confirm "SuperNova" + beta disclaimer
  - [ ] Send `/help` — confirm branding + no /setsl /settp
  - [ ] Open a test trade — confirm "⏳ Submitting…" → success flow
  - [ ] Tap a stale inline button — confirm no loading spinner
  - [ ] `curl` health endpoint — confirm DB + Redis checks
  - [ ] `curl` webhook without secret header — confirm 401
  - [ ] Rapid-tap 5 buttons — confirm no race condition
  - [ ] Check Pino logs — confirm GrammyError/HttpError differentiation
  - [ ] Run `/referral` — confirm "Direct/Indirect" labels
  - [ ] Run `/alerts` — confirm "Margin warning" label
  - [ ] Run `/withdraw` — confirm "Max safe" button label

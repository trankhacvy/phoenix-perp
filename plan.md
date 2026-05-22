# Wallet Info & Monitoring — Implementation Plan

Two features:
1. **`/wallet <address>`** — view any wallet's portfolio and trade history
2. **`/monitor`** — subscribe to fill/position-change alerts for arbitrary wallets

---

## Current state (from reading the code)

`getTraderState(walletAddress)` and `getTradeHistory(walletAddress)` in
`src/services/phoenix/position.ts` already accept any wallet address — they
aren't restricted to bot users. The Phoenix `traderState` WS channel is also
public. So both features are entirely possible with the existing SDK.

The two blockers:

**For `/wallet`:** `sendPortfolioScreen` (portfolio.ts:39) and
`sendHistoryScreen` (history.ts:122) both hardcode `ctx.user.walletAddress`.
They need a `walletAddress` param override.

**For monitoring:** The WS worker uses
`userCache: Map<walletAddress, telegramId>` — a 1:1 map. Multiple users
watching the same wallet would silently overwrite each other. Needs to become
`Map<walletAddress, Set<telegramId>>`. Bootstrap also only loads from Redis
`ws:positions:*` keys — it won't know about monitored wallets after a restart.

---

## Phase 1 — `/wallet <address>` command

### 1.1 Decouple `sendPortfolioScreen`

**File:** `src/bot/commands/portfolio.ts`

Current signature (line 39):
```ts
export async function sendPortfolioScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const [state, solLamports] = await Promise.all([
    getTraderState(ctx.user.walletAddress),
    solConnection.getBalance(new PublicKey(ctx.user.walletAddress)).catch(() => 0),
  ]);
```

Change to accept an optional `walletAddress` override. When provided, the
function operates in read-only "inspect" mode — no deposit/withdraw/trade
buttons, just an info card with a "Monitor" button.

```ts
export async function sendPortfolioScreen(
  ctx: BotContext,
  walletAddress?: string,  // if absent, falls back to ctx.user.walletAddress
): Promise<void> {
  const targetWallet = walletAddress ?? ctx.user?.walletAddress;
  if (!targetWallet) return;
  const isOwnWallet = !walletAddress || walletAddress === ctx.user?.walletAddress;

  const [state, solLamports] = await Promise.all([
    getTraderState(targetWallet),
    solConnection.getBalance(new PublicKey(targetWallet)).catch(() => 0),
  ]);

  // ... all existing formatting logic unchanged, just replace
  //     ctx.user.walletAddress → targetWallet ...

  // Keyboard differs by mode
  const kb = isOwnWallet
    ? new InlineKeyboard()
        .text("📥 Deposit", "nav:deposit")
        .text("📤 Withdraw", "nav:withdraw")
        .row()
        .text("🟢 Long", "nav:long")
        .text("🔴 Short", "nav:short")
        .row()
        .text("📋 History", "nav:history")
    : new InlineKeyboard()
        .text("📋 Trade History", `walletinfo:hist:${targetWallet}:0`)
        .row()
        .text("👁 Monitor", `monitor:add:${targetWallet}`);

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

### 1.2 Decouple `sendHistoryScreen`

**File:** `src/bot/commands/history.ts`

Current signature (line 122):
```ts
export async function sendHistoryScreen(ctx: BotContext, page = 0, edit = false): Promise<void> {
  if (!ctx.user) return;
  const history = await getTradeHistory(ctx.user.walletAddress, FETCH_LIMIT);
```

Add `walletAddress` param:
```ts
export async function sendHistoryScreen(
  ctx: BotContext,
  page = 0,
  edit = false,
  walletAddress?: string,  // external wallet override
): Promise<void> {
  const targetWallet = walletAddress ?? ctx.user?.walletAddress;
  if (!targetWallet) return;

  const history = await getTradeHistory(targetWallet, FETCH_LIMIT);

  // ... existing pagination and render logic unchanged ...

  // When rendering an external wallet, use "walletinfo:hist:<addr>:<page>"
  // as the callback prefix instead of "hist:list:<page>"
  const prefix = walletAddress ? `walletinfo:hist:${walletAddress}` : "hist:list";
  const kb = buildListKeyboard(safePage, totalPages, prefix, !!walletAddress);
}
```

Update `buildListKeyboard` to accept the prefix and hide own-account nav
buttons when inspecting an external wallet:
```ts
function buildListKeyboard(
  page: number,
  totalPages: number,
  prefix = "hist:list",
  external = false,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  addPaginationRow(kb, prefix, page, totalPages);
  if (!external) {
    kb.text("📊 Positions", "nav:positions").text("💰 Balance", "nav:balance");
  }
  return kb;
}
```

### 1.3 New command file

**New file:** `src/bot/commands/wallet.ts`

```ts
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import type { BotContext } from "../../types/index.js";
import { sendPortfolioScreen } from "./portfolio.js";
import { sendHistoryScreen } from "./history.js";

// Validates a base58 Solana address (32–44 chars, base58 alphabet)
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function registerWallet(bot: Bot<BotContext>) {
  // /wallet <address>
  bot.command("wallet", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }

    const arg = ctx.match?.trim();
    if (!arg || !BASE58_RE.test(arg)) {
      const msg = fmt`Send a Solana wallet address:\n${FormattedString.code("/wallet <address>")}`;
      await ctx.reply(msg.text, { entities: msg.entities });
      return;
    }

    await ctx.reply("Looking up wallet…");
    await sendPortfolioScreen(ctx, arg);
  });

  // Pagination for external wallet trade history
  // Callback: "walletinfo:hist:<address>:<page>"
  bot.callbackQuery(/^walletinfo:hist:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const address = ctx.match[1];
    const page = Number(ctx.match[2]);
    await sendHistoryScreen(ctx, page, true, address);
  });

  // "Monitor" quick-action button from wallet info view
  // Callback: "monitor:add:<address>"  — hands off to the monitor command handler
  // (handled in wallet-monitor.ts, registered separately)
}
```

### 1.4 Wire into `src/bot/commands/index.ts`

```ts
import { registerWallet } from "./wallet.js";

export function registerCommands(bot: Bot<BotContext>) {
  // ... existing registrations ...
  registerWallet(bot);
  // ...
}
```

---

## Phase 2 — Database schema for wallet monitoring

### 2.1 New schema file

**New file:** `src/db/schema/wallet_monitors.ts`

```ts
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const walletMonitors = pgTable("wallet_monitors", {
  id: text("id").primaryKey(),         // nanoid()
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  watchedWallet: text("watched_wallet").notNull(),
  label: text("label"),                // optional user-assigned nickname
  alertOnFill: boolean("alert_on_fill").default(true).notNull(),
  alertOnPositionChange: boolean("alert_on_position_change").default(true).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type WalletMonitor = typeof walletMonitors.$inferSelect;
export type NewWalletMonitor = typeof walletMonitors.$inferInsert;
```

Unique constraint: one user cannot monitor the same wallet twice. Add to the
table definition:

```ts
import { boolean, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const walletMonitors = pgTable(
  "wallet_monitors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    watchedWallet: text("watched_wallet").notNull(),
    label: text("label"),
    alertOnFill: boolean("alert_on_fill").default(true).notNull(),
    alertOnPositionChange: boolean("alert_on_position_change").default(true).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("wallet_monitors_user_wallet_unique").on(t.userId, t.watchedWallet)],
);
```

### 2.2 Export from schema index

**File:** `src/db/schema/index.ts`
```ts
export * from "./users.js";
export * from "./alerts.js";
export * from "./referrals.js";
export * from "./settings.js";
export * from "./wallet_monitors.js";  // add this line
```

### 2.3 Apply migration

```bash
pnpm db:generate   # generates migration SQL from new schema
pnpm db:migrate    # applies to DB
```

---

## Phase 3 — WS worker refactor (1:1 → 1:many)

This is the most surgical change. The current design at `src/workers/ws.ts`:

```ts
// Current — 1:1 mapping
const connections = new Map<string, WebSocket>();  // wallet → WS
const userCache = new Map<string, string>();        // wallet → telegramId (single!)
const reconnecting = new Set<string>();
const reconnectFailures = new Map<string, number>();
```

### 3.1 Replace `userCache` with a watcher index

```ts
// New — 1:many mapping
const connections = new Map<string, WebSocket>();           // wallet → WS (unchanged)
const reconnecting = new Set<string>();                      // unchanged
const reconnectFailures = new Map<string, number>();         // unchanged

// wallet → Set of telegramIds that want alerts for this wallet
const watcherIndex = new Map<string, Set<string>>();

// wallet → ownerTelegramId  (bot user who owns the wallet — gets risk/fill/referral logic)
// A wallet is an "owned" wallet if the Telegram user's walletAddress === this wallet.
// Monitored wallets may have NO owner in this map.
const ownerMap = new Map<string, string>();                  // wallet → telegramId | undefined
```

### 3.2 Update `subscribeUser` (own-account subscriptions)

Current (lines 44–120) takes `(walletAddress, telegramId)` and writes to
`userCache`. Replace the body to write to both `ownerMap` and `watcherIndex`:

```ts
export async function subscribeUser(walletAddress: string, telegramId: string) {
  // Register this user as the wallet owner
  ownerMap.set(walletAddress, telegramId);

  // Also add them as a watcher (owners see their own fills too)
  addWatcher(walletAddress, telegramId);

  // Start WS if not already running for this wallet
  await ensureConnection(walletAddress);
}
```

### 3.3 New `subscribeMonitored` for external wallet watchers

```ts
export async function subscribeMonitored(watchedWallet: string, telegramId: string) {
  addWatcher(watchedWallet, telegramId);
  await ensureConnection(watchedWallet);
}

export function unsubscribeMonitored(watchedWallet: string, telegramId: string) {
  const watchers = watcherIndex.get(watchedWallet);
  if (!watchers) return;
  watchers.delete(telegramId);

  // Only close connection if no watchers remain and no owner
  if (watchers.size === 0 && !ownerMap.has(watchedWallet)) {
    const ws = connections.get(watchedWallet);
    ws?.close();
    connections.delete(watchedWallet);
    watcherIndex.delete(watchedWallet);
  }
}

function addWatcher(walletAddress: string, telegramId: string) {
  if (!watcherIndex.has(walletAddress)) {
    watcherIndex.set(walletAddress, new Set());
  }
  watcherIndex.get(walletAddress)!.add(telegramId);
}
```

### 3.4 Extract `ensureConnection` (replaces the inline WS setup in `subscribeUser`)

The current `subscribeUser` body embeds all the WS setup inline. Extract it so
`subscribeMonitored` can reuse it:

```ts
async function ensureConnection(walletAddress: string) {
  if (connections.has(walletAddress)) return;   // already connected

  const ws = new WebSocket(config.PHOENIX_WS_URL);
  connections.set(walletAddress, ws);

  ws.on("open", () => {
    reconnectFailures.delete(walletAddress);
    ws.send(JSON.stringify({
      type: "subscribe",
      subscription: { channel: "traderState", wallet: walletAddress },
    }));
    logger.info({ walletAddress }, "WS subscribed: traderState");
  });

  ws.on("message", async (raw) => {
    try {
      const event = JSON.parse(raw.toString()) as TraderStateEvent;
      await handleTraderStateEvent(walletAddress, event);
    } catch (err) {
      logger.error({ err, walletAddress }, "WS message parse error");
    }
  });

  ws.on("close", () => {
    connections.delete(walletAddress);
    logger.info({ walletAddress }, "WS closed");
    if (reconnecting.has(walletAddress)) return;
    reconnecting.add(walletAddress);
    setTimeout(async () => {
      reconnecting.delete(walletAddress);
      // Only reconnect if there are still watchers
      const hasWatchers =
        (watcherIndex.get(walletAddress)?.size ?? 0) > 0 || ownerMap.has(walletAddress);
      if (hasWatchers) {
        await ensureConnection(walletAddress).catch((err) =>
          logger.error({ err, walletAddress }, "WS reconnect failed"),
        );
      }
    }, 5000);
  });

  ws.on("error", (err) => {
    logger.error({ err, walletAddress }, "WS error");
    const failures = (reconnectFailures.get(walletAddress) ?? 0) + 1;
    reconnectFailures.set(walletAddress, failures);

    if (failures >= MAX_RECONNECT_FAILURES) {
      reconnectFailures.delete(walletAddress);
      // Notify owner only (not all watchers) on connectivity issues
      const ownerTid = ownerMap.get(walletAddress);
      if (ownerTid) {
        alertQueue.add("ws-error", {
          telegramId: ownerTid,
          type: "fill",
          symbol: undefined,
          message: "⚠️ <b>Live alerts interrupted</b>\n\nWe lost connection to the market feed. Reconnecting…\n\nUse /positions to check your account.",
        }).catch(() => undefined);
      }
    }
  });
}
```

### 3.5 Split the event handler into two paths

Currently the WS message handler (ws.ts ~lines 58–120) does everything inline.
Extract into `handleTraderStateEvent`, which routes to the right path:

```ts
async function handleTraderStateEvent(walletAddress: string, event: TraderStateEvent) {
  const ownerTid = ownerMap.get(walletAddress);
  const watchers = watcherIndex.get(walletAddress) ?? new Set<string>();

  // Path A: own-account logic (risk alerts, TP/SL flip, referral accrual)
  if (ownerTid) {
    await handleOwnAccountEvent(walletAddress, ownerTid, event);
  }

  // Path B: monitored wallet — fan out fill/position alerts to all watchers
  //         who are NOT the owner (owner already handled above)
  const externalWatchers = [...watchers].filter((tid) => tid !== ownerTid);
  if (externalWatchers.length > 0) {
    await handleMonitoredWalletEvent(walletAddress, externalWatchers, event);
  }
}
```

### 3.6 `handleOwnAccountEvent` (existing logic, just extracted)

```ts
async function handleOwnAccountEvent(
  walletAddress: string,
  telegramId: string,
  event: TraderStateEvent,
) {
  // TP/SL flip detection (existing Redis prev-state logic)
  const prevKey = `ws:positions:${walletAddress}`;
  const prev = await redis.get(prevKey);
  if (prev) {
    const prevPositions = JSON.parse(prev) as TraderStateEvent["positions"];
    for (const pos of event.positions) {
      const prevPos = prevPositions.find((p) => p.symbol === pos.symbol);
      if (prevPos && prevPos.side !== pos.side) {
        await alertQueue.add("tpsl-flip", {
          telegramId,
          type: "tpsl_flip",
          symbol: pos.symbol,
          message: [
            `🔄 <b>Position Flipped: ${pos.symbol}</b>`,
            "Your TP/SL orders were cancelled by the protocol.",
            "Tap /positions to reattach TP/SL.",
          ].join("\n"),
        });
      }
    }
  }
  await redis.set(prevKey, JSON.stringify(event.positions), "EX", 3600);

  // Risk tier alert (existing logic)
  const alertMsg = buildRiskAlertMessage(event);
  if (alertMsg) {
    await alertQueue.add("risk-tier", {
      telegramId,
      type: event.riskTier.toLowerCase(),
      message: alertMsg,
    });
  }

  // Fill alerts + referral accrual (existing logic)
  for (const fill of event.fills ?? []) {
    await alertQueue.add("fill", {
      telegramId,
      type: "fill",
      symbol: fill.symbol,
      message: [
        `✅ <b>Order Filled: ${fill.symbol}</b>`,
        `Side: ${fill.side.toUpperCase()}`,
        `Size: ${fill.size} | Price: $${fill.price}`,
        `Fee: $${fill.fee}`,
      ].join("\n"),
    });

    const userId = await getOwnerUserId(walletAddress);
    if (userId) {
      const notional = Number(fill.size) * Number(fill.price);
      await accrueReferralFee(userId, notional).catch((err) =>
        logger.error({ err }, "Referral fee accrual failed"),
      );
    }
  }
}
```

### 3.7 `handleMonitoredWalletEvent` (new path)

Position changes need a prev-state comparison. We reuse the same
`ws:positions:<wallet>` Redis key — it's already written by
`handleOwnAccountEvent` if the wallet also has an owner. For wallets that are
only monitored (no bot user owns them), we write it here.

```ts
async function handleMonitoredWalletEvent(
  walletAddress: string,
  watcherTelegramIds: string[],
  event: TraderStateEvent,
) {
  const short = `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`;

  // Detect position changes (opened, closed, side flip)
  const prevKey = `ws:positions:${walletAddress}`;
  const prev = await redis.get(prevKey);
  const prevPositions: TraderStateEvent["positions"] = prev ? JSON.parse(prev) : [];

  // Only write prev-state if no owner (owner path already writes it)
  if (!ownerMap.has(walletAddress)) {
    await redis.set(prevKey, JSON.stringify(event.positions), "EX", 3600);
  }

  const alerts: { type: string; symbol: string; message: string }[] = [];

  // New positions (opened)
  for (const pos of event.positions) {
    const existed = prevPositions.find((p) => p.symbol === pos.symbol);
    if (!existed) {
      alerts.push({
        type: "monitor_open",
        symbol: pos.symbol,
        message: [
          `👁 <b>${short} opened ${pos.symbol}</b>`,
          `${pos.side.toUpperCase()} · ${pos.size} ${pos.symbol} @ $${pos.entryPrice}`,
          pos.leverage ? `Leverage: ${pos.leverage}x` : "",
        ].filter(Boolean).join("\n"),
      });
    } else if (existed.side !== pos.side) {
      // Position flipped
      alerts.push({
        type: "monitor_flip",
        symbol: pos.symbol,
        message: [
          `👁 <b>${short} flipped ${pos.symbol}</b>`,
          `${existed.side.toUpperCase()} → ${pos.side.toUpperCase()}`,
        ].join("\n"),
      });
    }
  }

  // Closed positions
  for (const prev of prevPositions) {
    const still = event.positions.find((p) => p.symbol === prev.symbol);
    if (!still) {
      alerts.push({
        type: "monitor_close",
        symbol: prev.symbol,
        message: [
          `👁 <b>${short} closed ${prev.symbol}</b>`,
          `Was ${prev.side.toUpperCase()} · ${prev.size} ${prev.symbol}`,
        ].join("\n"),
      });
    }
  }

  // Fills
  for (const fill of event.fills ?? []) {
    alerts.push({
      type: "monitor_fill",
      symbol: fill.symbol,
      message: [
        `👁 <b>${short} filled ${fill.symbol}</b>`,
        `${fill.side.toUpperCase()} · ${fill.size} @ $${fill.price}`,
      ].join("\n"),
    });
  }

  // Fan out to all external watchers
  for (const telegramId of watcherTelegramIds) {
    for (const alert of alerts) {
      await alertQueue.add("monitor-alert", {
        telegramId,
        type: alert.type,
        symbol: alert.symbol,
        message: alert.message,
      });
    }
  }
}
```

### 3.8 Update bootstrap

Current bootstrap (ws.ts ~line 265) only loads from Redis `ws:positions:*`
keys. It needs to also load from the `wallet_monitors` table.

```ts
async function bootstrap() {
  // 1. Subscribe own-account wallets (existing logic)
  const ownWallets = await db
    .select({ walletAddress: users.walletAddress, telegramId: users.telegramId })
    .from(users);

  for (const user of ownWallets) {
    await subscribeUser(user.walletAddress, user.telegramId);
  }

  // 2. Subscribe monitored wallets
  //    Pull distinct (watchedWallet, telegramId) pairs for all enabled monitors
  const monitors = await db
    .select({
      watchedWallet: walletMonitors.watchedWallet,
      telegramId: users.telegramId,
    })
    .from(walletMonitors)
    .innerJoin(users, eq(walletMonitors.userId, users.id))
    .where(eq(walletMonitors.enabled, true));

  for (const m of monitors) {
    await subscribeMonitored(m.watchedWallet, m.telegramId);
  }

  logger.info(
    { ownWallets: ownWallets.length, monitors: monitors.length },
    "WS worker bootstrapped",
  );

  subscribeAllMids();
}
```

> **Note:** The old bootstrap used Redis `ws:positions:*` keys to infer which
> wallets needed subscriptions. Replace it entirely with a DB query — it's
> authoritative and avoids the risk of stale Redis keys after crashes.

### 3.9 Update `unsubscribeUser`

```ts
export function unsubscribeUser(walletAddress: string) {
  ownerMap.delete(walletAddress);
  // Keep the watcher entry; external users may still be monitoring this wallet.
  // If no watchers remain either, close the connection.
  const watchers = watcherIndex.get(walletAddress);
  if (!watchers || watchers.size === 0) {
    const ws = connections.get(walletAddress);
    ws?.close();
    connections.delete(walletAddress);
    watcherIndex.delete(walletAddress);
  }
}
```

---

## Phase 4 — `/monitor` bot commands

### 4.1 New command file

**New file:** `src/bot/commands/wallet-monitor.ts`

```ts
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { and, eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { walletMonitors } from "../../db/schema/wallet_monitors.js";
import { users } from "../../db/schema/users.js";
import { subscribeMonitored, unsubscribeMonitored } from "../../workers/ws.js";
import type { BotContext } from "../../types/index.js";
import { shortAddr } from "../lib/fmt.js";
import { sendPortfolioScreen } from "./portfolio.js";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_MONITORS = 10;  // per user

// ─── /monitor ────────────────────────────────────────────────────────────────

async function sendMonitorList(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;

  const rows = await db
    .select()
    .from(walletMonitors)
    .where(and(eq(walletMonitors.userId, ctx.user.id), eq(walletMonitors.enabled, true)));

  if (rows.length === 0) {
    const msg = fmt`👁 ${FormattedString.b("Wallet Monitor")}\n\nNo wallets monitored yet.\n\nUse ${FormattedString.code("/monitor add <address>")} to start.`;
    const text = msg.text;
    const opts = { entities: msg.entities };
    if (edit && ctx.callbackQuery) await ctx.editMessageText(text, opts);
    else await ctx.reply(text, opts);
    return;
  }

  const lines = rows.map((r, i) => {
    const name = r.label ?? shortAddr(r.watchedWallet);
    return fmt`${i + 1}. ${FormattedString.b(name)}  ${FormattedString.code(shortAddr(r.watchedWallet))}`;
  });

  const header = fmt`👁 ${FormattedString.b("Monitored Wallets")}`;
  const msg = FormattedString.join([header, "", ...lines], "\n");

  const kb = new InlineKeyboard();
  for (const r of rows) {
    const name = r.label ?? shortAddr(r.watchedWallet);
    kb.text(`🗑 ${name}`, `monitor:rm:${r.id}`).row();
  }
  kb.text("+ Add wallet", "monitor:prompt_add");

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
  else await ctx.reply(msg.text, opts);
}

// ─── Add flow ─────────────────────────────────────────────────────────────────

async function handleAddMonitor(ctx: BotContext, walletAddress: string): Promise<void> {
  if (!ctx.user) return;

  // Enforce per-user cap
  const count = await db
    .$count(walletMonitors, and(eq(walletMonitors.userId, ctx.user.id), eq(walletMonitors.enabled, true)));
  if (count >= MAX_MONITORS) {
    await ctx.reply(`You can monitor up to ${MAX_MONITORS} wallets. Remove one first with /monitor.`);
    return;
  }

  // Prevent monitoring own wallet
  if (walletAddress === ctx.user.walletAddress) {
    await ctx.reply("That's your own wallet — you already get alerts for it.");
    return;
  }

  await db
    .insert(walletMonitors)
    .values({
      id: nanoid(),
      userId: ctx.user.id,
      watchedWallet: walletAddress,
      alertOnFill: true,
      alertOnPositionChange: true,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [walletMonitors.userId, walletMonitors.watchedWallet],
      set: { enabled: true },
    });

  // Subscribe in the live WS worker
  await subscribeMonitored(walletAddress, ctx.user.telegramId);

  const msg = fmt`✅ Now monitoring ${FormattedString.code(shortAddr(walletAddress))}\n\nYou'll get alerts when this wallet opens, closes, or fills a position.`;
  const kb = new InlineKeyboard().text("← My monitors", "monitor:list");
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

// ─── Remove ───────────────────────────────────────────────────────────────────

async function handleRemoveMonitor(ctx: BotContext, monitorId: string): Promise<void> {
  if (!ctx.user) return;

  const [removed] = await db
    .update(walletMonitors)
    .set({ enabled: false })
    .where(and(eq(walletMonitors.id, monitorId), eq(walletMonitors.userId, ctx.user.id)))
    .returning();

  if (!removed) {
    await ctx.answerCallbackQuery("Not found.");
    return;
  }

  // Unsubscribe from WS (only removes this user's watcher — others unaffected)
  unsubscribeMonitored(removed.watchedWallet, ctx.user.telegramId);

  await ctx.answerCallbackQuery("Removed.");
  await sendMonitorList(ctx, true);
}

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerWalletMonitor(bot: Bot<BotContext>) {
  // /monitor — show list
  bot.command("monitor", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendMonitorList(ctx);
  });

  // /monitor add <address>
  // Also handles: /monitor <address>  (shorthand)
  bot.command("monitor", async (ctx) => {
    if (!ctx.user) return;
    const arg = ctx.match?.trim();
    if (!arg) {
      await sendMonitorList(ctx);
      return;
    }
    if (!BASE58_RE.test(arg)) {
      await ctx.reply("Invalid wallet address.");
      return;
    }
    await handleAddMonitor(ctx, arg);
  });

  // Callback: "monitor:list" — re-render monitor list (used by nav buttons)
  bot.callbackQuery("monitor:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendMonitorList(ctx, true);
  });

  // Callback: "monitor:prompt_add" — ask user to send an address
  bot.callbackQuery("monitor:prompt_add", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const msg = fmt`Send the Solana wallet address to monitor:`;
    await ctx.reply(msg.text, { entities: msg.entities });
    // Store pending state so the free-text handler picks it up
    const { setPending } = await import("../lib/pending.js");
    await setPending(ctx.from.id, "monitor_add");
  });

  // Callback: "monitor:add:<address>" — from /wallet info view's "Monitor" button
  bot.callbackQuery(/^monitor:add:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await handleAddMonitor(ctx, ctx.match[1]);
  });

  // Callback: "monitor:rm:<id>" — remove a monitored wallet
  bot.callbackQuery(/^monitor:rm:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await handleRemoveMonitor(ctx, ctx.match[1]);
  });
}
```

### 4.2 Wire pending state in `src/bot/index.ts`

Add a `monitor_add` case to the free-text handler:

```ts
// In bot.on("message:text") handler, add after existing cases:

if (pending === "monitor_add") {
  const address = text.trim();
  if (!BASE58_RE.test(address)) {
    await ctx.reply("Invalid address. Send a valid Solana wallet address.");
    return;
  }
  const { handleAddMonitor } = await import("./commands/wallet-monitor.js");
  await handleAddMonitor(ctx, address);
  return;
}
```

> `BASE58_RE` should be extracted to a shared constant in `src/bot/lib/validate.ts`
> to avoid duplication across `wallet.ts`, `wallet-monitor.ts`, and `bot/index.ts`.

### 4.3 Register in `src/bot/commands/index.ts`

```ts
import { registerWalletMonitor } from "./wallet-monitor.js";

export function registerCommands(bot: Bot<BotContext>) {
  // ... existing ...
  registerWalletMonitor(bot);
  registerWallet(bot);
}
```

---

## Phase 5 — Alert dedup for monitored wallets

The existing alert worker dedup key is:
```
alert:dedup:{telegramId}:{type}:{symbol}  — 5s TTL
```

For monitor alerts, `type` values are `monitor_open`, `monitor_close`,
`monitor_fill`, `monitor_flip`. These are distinct from own-account types so
there's no collision. The 5s window is appropriate — enough to suppress
WS reconnect duplicates but short enough not to miss a real second trade.

No changes needed to the alert worker. The existing dedup logic handles this
automatically.

---

## File change summary

| File | Action | Notes |
|---|---|---|
| `src/bot/commands/portfolio.ts` | Modify | Add `walletAddress?: string` param to `sendPortfolioScreen` |
| `src/bot/commands/history.ts` | Modify | Add `walletAddress?: string` param to `sendHistoryScreen`; update callback prefix logic |
| `src/bot/commands/wallet.ts` | New | `/wallet <address>` command + `walletinfo:hist:*` callbacks |
| `src/bot/commands/wallet-monitor.ts` | New | `/monitor` command + all monitor callbacks |
| `src/bot/commands/index.ts` | Modify | Register `registerWallet` and `registerWalletMonitor` |
| `src/bot/index.ts` | Modify | Add `monitor_add` pending state handler; extract `BASE58_RE` |
| `src/bot/lib/validate.ts` | New | Shared `BASE58_RE` constant |
| `src/db/schema/wallet_monitors.ts` | New | `walletMonitors` table schema |
| `src/db/schema/index.ts` | Modify | Export `wallet_monitors` |
| `src/workers/ws.ts` | Modify | Replace `userCache` with `watcherIndex`+`ownerMap`; extract `ensureConnection`; add `subscribeMonitored`/`unsubscribeMonitored`; refactor bootstrap; split event handler |
| Migration SQL | Generated | `pnpm db:generate && pnpm db:migrate` |

---

## Build order

1. **DB schema + migration** (Phase 2) — no app changes, safe to land first.
2. **WS worker refactor** (Phase 3) — purely internal; existing behaviour
   preserved. All existing `subscribeUser` calls still work.
3. **`/wallet` command** (Phase 1) — read-only, no DB writes.
4. **`/monitor` commands** (Phase 4) — depends on new schema and WS changes.

---

## Known edge cases

| Case | Handling |
|---|---|
| User monitors a wallet that also belongs to a bot user | `ownerMap` and `watcherIndex` are separate; own-account logic fires for the owner, monitor alerts fan out to external watchers. No double-alerting because `handleMonitoredWalletEvent` skips `ownerTid`. |
| WS worker restarts while monitors are active | Bootstrap queries `wallet_monitors` table directly — all subscriptions restored. No Redis dependency for subscription state. |
| User disables monitor while WS event is in-flight | The BullMQ job is already queued; it will deliver once. Subsequent events won't queue because `watcherIndex` no longer contains the user. Acceptable. |
| Monitored wallet has no Phoenix account | `getTraderState` returns an empty state (safe tier, zero collateral, no positions). First WS event has no fills or positions — no alerts sent. |
| Same wallet monitored by 100 users | Still 1 WS connection. `handleMonitoredWalletEvent` fans out to all 100 `telegramId`s. BullMQ handles the 100 alert jobs concurrently (concurrency=10). |
| User hits `/monitor add` for a wallet already monitored | `onConflictDoUpdate` sets `enabled=true` — idempotent. Shows a success message. |

---

## Todo List

### Phase 0 — Shared utility (prerequisite for all phases)

- [x] **0.1** Create `src/bot/lib/validate.ts` — export `BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/` as a named constant so it isn't copy-pasted across three files

---

### Phase 1 — `/wallet <address>` command

**1.1 — Decouple `sendPortfolioScreen` from `ctx.user`**
- [x] **1.1.1** Add `walletAddress?: string` param to `sendPortfolioScreen` in `src/bot/commands/portfolio.ts`
- [x] **1.1.2** Replace every `ctx.user.walletAddress` reference in that function with a local `targetWallet = walletAddress ?? ctx.user?.walletAddress` variable
- [x] **1.1.3** Add `isOwnWallet` boolean flag (`!walletAddress || walletAddress === ctx.user?.walletAddress`)
- [x] **1.1.4** Render a different `InlineKeyboard` when `isOwnWallet === false`: replace Deposit/Withdraw/Long/Short/History buttons with `"📋 Trade History"` (`walletinfo:hist:<address>:0`) and `"👁 Monitor"` (`monitor:add:<address>`) buttons
- [x] **1.1.5** Guard early return: when called with an external `walletAddress`, skip the `if (!ctx.user) return` guard (the function doesn't need an authenticated user to read public state)

**1.2 — Decouple `sendHistoryScreen` from `ctx.user`**
- [x] **1.2.1** Add `walletAddress?: string` param to `sendHistoryScreen` in `src/bot/commands/history.ts`
- [x] **1.2.2** Replace `ctx.user.walletAddress` with `targetWallet = walletAddress ?? ctx.user?.walletAddress`
- [x] **1.2.3** Add `isExternal` boolean param (or derive it from `!!walletAddress`)
- [x] **1.2.4** Update `buildListKeyboard` to accept a `prefix` string param (default `"hist:list"`) and an `external` boolean; when `external === true`, omit the "Positions / Balance" nav buttons
- [x] **1.2.5** When `isExternal`, pass prefix `walletinfo:hist:${walletAddress}` to `buildListKeyboard` so pagination callbacks carry the wallet address
- [x] **1.2.6** Export `sendHistoryScreen` signature is already exported — verify nothing else calls it with old positional args and breaks

**1.3 — New `/wallet` command**
- [x] **1.3.1** Create `src/bot/commands/wallet.ts`
- [x] **1.3.2** Implement `registerWallet(bot)` — register `bot.command("wallet", ...)` handler
- [x] **1.3.3** In the command handler: extract `ctx.match` arg, validate with `BASE58_RE` (from `validate.ts`), reply with usage hint if missing/invalid
- [x] **1.3.4** Call `sendPortfolioScreen(ctx, arg)` to render the external wallet overview
- [x] **1.3.5** Register `bot.callbackQuery(/^walletinfo:hist:([...]{32,44}):(\d+)$/, ...)` — parse wallet address and page, call `sendHistoryScreen(ctx, page, true, address)`
- [x] **1.3.6** Add import and call `registerWallet(bot)` in `src/bot/commands/index.ts`

---

### Phase 2 — Database schema

- [x] **2.1** Create `src/db/schema/wallet_monitors.ts` with the `walletMonitors` table definition (columns: `id`, `userId`, `watchedWallet`, `label`, `alertOnFill`, `alertOnPositionChange`, `enabled`, `createdAt`)
- [x] **2.2** Add `unique("wallet_monitors_user_wallet_unique").on(t.userId, t.watchedWallet)` table-level constraint to prevent duplicate monitor rows per user
- [x] **2.3** Export `WalletMonitor` and `NewWalletMonitor` inferred types from the schema file
- [x] **2.4** Add `export * from "./wallet_monitors.js"` to `src/db/schema/index.ts`
- [x] **2.5** Run `pnpm db:generate` — verify the generated migration SQL creates the `wallet_monitors` table with the unique constraint
- [x] **2.6** Run `pnpm db:migrate` — apply to local dev database
- [x] **2.7** Verify with `pnpm db:studio` (Drizzle Studio) that the table exists with the expected columns

---

### Phase 3 — WS worker refactor

**3.1 — Replace module-level data structures**
- [x] **3.1.1** In `src/workers/ws.ts`, delete `const userCache = new Map<string, string>()` (line ~10)
- [x] **3.1.2** Add `const watcherIndex = new Map<string, Set<string>>()` — wallet → Set of telegramIds
- [x] **3.1.3** Add `const ownerMap = new Map<string, string>()` — wallet → ownerTelegramId
- [x] **3.1.4** Add private helper `function addWatcher(walletAddress: string, telegramId: string)` — creates the Set if absent, then adds telegramId

**3.2 — Refactor `subscribeUser`**
- [x] **3.2.1** Replace the body of `subscribeUser` — call `ownerMap.set(walletAddress, telegramId)`, call `addWatcher(walletAddress, telegramId)`, then call `await ensureConnection(walletAddress)`
- [x] **3.2.2** Remove all inline `new WebSocket(...)` setup from inside `subscribeUser` (it moves to `ensureConnection`)

**3.3 — Extract `ensureConnection`**
- [x] **3.3.1** Create private async function `ensureConnection(walletAddress: string)` — guard with `if (connections.has(walletAddress)) return`
- [x] **3.3.2** Move the `new WebSocket(...)` + `ws.on("open")` + `ws.on("message")` + `ws.on("close")` + `ws.on("error")` setup block from `subscribeUser` into `ensureConnection`
- [x] **3.3.3** In the `ws.on("message")` handler, call `handleTraderStateEvent(walletAddress, event)` instead of inlining all logic
- [x] **3.3.4** In the `ws.on("close")` reconnect timer, only reconnect if `watcherIndex.get(walletAddress)?.size > 0 || ownerMap.has(walletAddress)` — prevents ghost reconnects after unsubscribe
- [x] **3.3.5** In the `ws.on("error")` MAX_RECONNECT_FAILURES branch, look up the owner via `ownerMap.get(walletAddress)` (not `userCache`) for the "alerts interrupted" message

**3.4 — Add `subscribeMonitored` and `unsubscribeMonitored`**
- [x] **3.4.1** Add exported `async function subscribeMonitored(watchedWallet: string, telegramId: string)` — calls `addWatcher`, then `ensureConnection`
- [x] **3.4.2** Add exported `function unsubscribeMonitored(watchedWallet: string, telegramId: string)` — removes telegramId from `watcherIndex`, then closes the WS connection and cleans up all maps if no watchers remain and no owner exists
- [x] **3.4.3** Update `unsubscribeUser` to `delete` from `ownerMap` instead of `userCache`, and close the connection only if `watcherIndex` for that wallet is also empty

**3.5 — Extract `handleTraderStateEvent` router**
- [x] **3.5.1** Create private async function `handleTraderStateEvent(walletAddress: string, event: TraderStateEvent)` 
- [x] **3.5.2** Look up `ownerTid = ownerMap.get(walletAddress)` and `watchers = watcherIndex.get(walletAddress)`
- [x] **3.5.3** If `ownerTid` exists, call `await handleOwnAccountEvent(walletAddress, ownerTid, event)`
- [x] **3.5.4** Compute `externalWatchers = [...watchers].filter(tid => tid !== ownerTid)`; if non-empty, call `await handleMonitoredWalletEvent(walletAddress, externalWatchers, event)`

**3.6 — Extract `handleOwnAccountEvent`**
- [x] **3.6.1** Create private async function `handleOwnAccountEvent(walletAddress, telegramId, event)` — move the existing TP/SL flip detection + Redis prev-state write + risk tier alert + fill alerts + referral accrual logic into it verbatim
- [x] **3.6.2** Replace the `getUserId` helper call with `getOwnerUserId` (rename the existing `getUserId` function to `getOwnerUserId` for clarity, or keep the name — just make it consistent)
- [x] **3.6.3** Verify that this function's logic is identical to the current `ws.on("message")` inline body — no behaviour change

**3.7 — Implement `handleMonitoredWalletEvent`**
- [x] **3.7.1** Create private async function `handleMonitoredWalletEvent(walletAddress, watcherTelegramIds, event)`
- [x] **3.7.2** Compute `short = walletAddress.slice(0,4) + "…" + walletAddress.slice(-4)` for display
- [x] **3.7.3** Read `ws:positions:<walletAddress>` from Redis to get previous positions; parse as `TraderStateEvent["positions"]`, default to `[]` if absent
- [x] **3.7.4** Only write the new snapshot to Redis if `!ownerMap.has(walletAddress)` — avoid a double-write race with `handleOwnAccountEvent`
- [x] **3.7.5** Detect newly opened positions: for each position in `event.positions` not found in `prevPositions` by symbol → push `monitor_open` alert (symbol, side, size, entry price, leverage if present)
- [x] **3.7.6** Detect side flips: for each position where the symbol exists in both but `side` changed → push `monitor_flip` alert
- [x] **3.7.7** Detect closed positions: for each position in `prevPositions` not found in `event.positions` → push `monitor_close` alert
- [x] **3.7.8** Detect fills: for each entry in `event.fills ?? []` → push `monitor_fill` alert (symbol, side, size, price)
- [x] **3.7.9** Fan out: for each `telegramId` in `watcherTelegramIds`, for each collected alert, call `alertQueue.add("monitor-alert", { telegramId, type, symbol, message })`

**3.8 — Update bootstrap**
- [x] **3.8.1** Import `walletMonitors` schema and `eq` from drizzle in `ws.ts`
- [x] **3.8.2** Replace the current bootstrap's Redis-key-based wallet discovery with a DB query: `db.select({ walletAddress, telegramId }).from(users)` — subscribe all bot users
- [x] **3.8.3** Add a second DB query for monitored wallets: join `walletMonitors` → `users` where `enabled = true`, subscribe each `(watchedWallet, telegramId)` pair via `subscribeMonitored`
- [x] **3.8.4** Update the bootstrap log line to include both counts: `{ ownWallets: N, monitors: M }`
- [x] **3.8.5** Remove the old `const keys = await redis.keys("ws:positions:*")` call and the `inArray(users.walletAddress, walletAddresses)` query — no longer needed

---

### Phase 4 — `/monitor` bot commands

**4.1 — New command file**
- [x] **4.1.1** Create `src/bot/commands/wallet-monitor.ts`
- [x] **4.1.2** Implement `sendMonitorList(ctx, edit?)` — query `walletMonitors` filtered by `userId` and `enabled=true`, render a numbered list, add a remove button per row and an "Add wallet" button
- [x] **4.1.3** Implement `handleAddMonitor(ctx, walletAddress)`:
  - Count existing enabled monitors for this user; reject if `>= MAX_MONITORS` (10)
  - Reject if `walletAddress === ctx.user.walletAddress` (own wallet)
  - `INSERT INTO wallet_monitors ... ON CONFLICT DO UPDATE SET enabled=true`
  - Call `subscribeMonitored(walletAddress, ctx.user.telegramId)` on the live WS worker
  - Reply with confirmation + "← My monitors" button
- [x] **4.1.4** Implement `handleRemoveMonitor(ctx, monitorId)`:
  - `UPDATE wallet_monitors SET enabled=false WHERE id=? AND userId=?` with `.returning()`
  - If no row returned, `answerCallbackQuery("Not found.")`
  - Call `unsubscribeMonitored(removed.watchedWallet, ctx.user.telegramId)`
  - Re-render the monitor list in place
- [x] **4.1.5** Implement `registerWalletMonitor(bot)`:
  - Register `bot.command("monitor", ...)`: if no arg, show list; if arg matches `BASE58_RE`, call `handleAddMonitor`; otherwise show usage error
  - Register `bot.callbackQuery("monitor:list", ...)` — re-render list in place
  - Register `bot.callbackQuery("monitor:prompt_add", ...)` — reply asking for address, set `pending:<telegramId>` to `"monitor_add"` via `setPending`
  - Register `bot.callbackQuery(/^monitor:add:<BASE58>$/, ...)` — call `handleAddMonitor` (triggered from `/wallet` view)
  - Register `bot.callbackQuery(/^monitor:rm:(.+)$/, ...)` — call `handleRemoveMonitor`
- [x] **4.1.6** Export `handleAddMonitor` so `bot/index.ts` can call it from the pending state handler

**4.2 — Wire pending state in `src/bot/index.ts`**
- [x] **4.2.1** Import `BASE58_RE` from `src/bot/lib/validate.ts`
- [x] **4.2.2** Add `if (pending === "monitor_add")` branch to the `bot.on("message:text")` handler — validate address with `BASE58_RE`, call `handleAddMonitor(ctx, address)`, return
- [x] **4.2.3** Remove any inline `BASE58_RE` literals that were added to `wallet.ts` or `wallet-monitor.ts` — all should import from `validate.ts`

**4.3 — Register commands**
- [x] **4.3.1** Add `import { registerWalletMonitor } from "./wallet-monitor.js"` to `src/bot/commands/index.ts`
- [x] **4.3.2** Call `registerWalletMonitor(bot)` inside `registerCommands` (before `registerWallet` so monitor callbacks are bound first — both are needed)
- [x] **4.3.3** Add `import { registerWallet } from "./wallet.js"` and call `registerWallet(bot)`

---

### Phase 5 — Verification

- [x] **5.1** Run `pnpm build` — confirm zero TypeScript errors after all changes
- [x] **5.2** Run `pnpm check` — confirm zero Biome lint/format errors
- [x] **5.3** Manual smoke test — `/wallet <own wallet address>`: verify it shows portfolio with read-only buttons
- [x] **5.4** Manual smoke test — `/wallet <external address with open positions>`: verify positions and history render correctly
- [x] **5.5** Manual smoke test — `/wallet <address with no Phoenix account>`: verify graceful empty state (no crash)
- [x] **5.6** Manual smoke test — `/monitor add <address>`: verify DB row inserted, confirmation message shown
- [x] **5.7** Manual smoke test — `/monitor`: verify list shows the monitored wallet
- [x] **5.8** Manual smoke test — remove a monitor via the 🗑 button: verify DB `enabled=false`, list updates
- [x] **5.9** Restart the WS worker after adding a monitor — verify bootstrap re-subscribes it (check logs for `{ ownWallets: N, monitors: 1 }`)
- [x] **5.10** Confirm existing own-account alerts still fire after WS refactor (fill alert, risk alert) — the `handleOwnAccountEvent` path must be unchanged
- [x] **5.11** Confirm dedup works for monitor alerts: same wallet fill → only one Telegram message within the 5s window

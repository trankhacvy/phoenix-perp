/**
 * Bot integration test harness.
 *
 * Exercises the full bot command flow against real Phoenix / Solana using the
 * TEST_KEYPAIR wallet. All Telegram API calls are intercepted locally — no
 * browser or Telegram account needed.
 *
 * Required env vars (in addition to normal app vars):
 *   TEST_KEYPAIR    base58-encoded 64-byte secret key
 *   POSITION_SIZE   SOL units to trade, e.g. "0.05"
 *
 * Usage:
 *   npx tsx scripts/test-bot.ts
 */

// dotenv must be first so .env values are available before anything else loads
import "dotenv/config";

// Stub vars that aren't needed for keypair-based testing but are required by
// the config Zod schema. Set BEFORE dynamic-importing src/* so config validation passes.
if (!process.env.PRIVY_APP_ID) process.env.PRIVY_APP_ID = "__test__";
if (!process.env.PRIVY_APP_SECRET) process.env.PRIVY_APP_SECRET = "__test__";
if (!process.env.BUILDER_AUTHORITY_PUBKEY)
  process.env.BUILDER_AUTHORITY_PUBKEY = "11111111111111111111111111111111";

// Dynamic imports so env stubs are in place before config.ts evaluates
const { db } = await import("../src/db/index.js");
const { users } = await import("../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { activatePhoenixAccount, initTestSigner } = await import("../src/services/wallet.js");
const { bot } = await import("../src/bot/index.js");
const { getMarketSnapshot } = await import("../src/services/phoenix/market.js");

// ─── Config ──────────────────────────────────────────────────────────────────

const TEST_TELEGRAM_ID = "999999999";
const POSITION_SIZE = Number(process.env.POSITION_SIZE ?? "0.05");
const LEVERAGE = 2;

// ─── Telegram API mock ───────────────────────────────────────────────────────

let _msgId = 100;
let lastConfirmCallback: string | null = null;

function nextMsgId() { return ++_msgId; }

function printReply(method: string, payload: Record<string, unknown>) {
  const text = ((payload.text as string | undefined) ?? "[no text]")
    .replace(/<b>(.*?)<\/b>/g, "$1")
    .replace(/<code>(.*?)<\/code>/g, "$1")
    .replace(/<i>(.*?)<\/i>/g, "$1")
    .replace(/<[^>]+>/g, "");

  console.log(`\n  ┌─ ${method}`);
  for (const line of text.split("\n")) {
    console.log(`  │ ${line}`);
  }

  const kb = payload.reply_markup as
    | { inline_keyboard?: { text: string; callback_data?: string }[][] }
    | undefined;
  if (kb?.inline_keyboard) {
    const buttons = kb.inline_keyboard.flat().filter((b) => b.callback_data);
    if (buttons.length) {
      console.log(`  │ [keyboard]`);
      for (const btn of buttons) {
        console.log(`  │   "${btn.text}" → ${btn.callback_data}`);
        const d = btn.callback_data!;
        if (
          d.startsWith("confirm:") ||
          d.startsWith("setsl:confirm") ||
          d.startsWith("settp:confirm") ||
          d.startsWith("withdraw:confirm")
        ) {
          lastConfirmCallback = d;
        }
      }
    }
  }
  console.log("  └─");
}

function mockMessage(chatId: number, text: string) {
  const id = nextMsgId();
  return {
    message_id: id,
    from: { id: 1, is_bot: true, first_name: "Bot" },
    chat: { id: chatId, type: "private" as const },
    date: Math.floor(Date.now() / 1000),
    text,
  } as const;
}

// Intercept ALL Telegram API calls — nothing leaves to Telegram
bot.api.config.use(async (_prev, method, payload, _signal) => {
  const p = payload as Record<string, unknown>;
  const chatId = Number((p.chat_id as string | number | undefined) ?? TEST_TELEGRAM_ID);

  if (method === "getMe") {
    return {
      ok: true,
      result: { id: 1, is_bot: true, first_name: "TestBot", username: "testbot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false },
    } as never;
  }

  if (method === "sendMessage") {
    printReply("sendMessage", p);
    return { ok: true, result: mockMessage(chatId, p.text as string) } as never;
  }
  if (method === "editMessageText") {
    printReply("editMessageText", p);
    return { ok: true, result: mockMessage(chatId, p.text as string) } as never;
  }
  if (method === "answerCallbackQuery") {
    const text = (p.text as string | undefined) ?? "";
    if (text) console.log(`  ↩  ${text}`);
    return { ok: true, result: true } as never;
  }
  if (method === "sendPhoto") {
    console.log("\n  ┌─ sendPhoto [P&L card image]");
    console.log("  └─");
    return { ok: true, result: { ...mockMessage(chatId, "[photo]"), photo: [] } } as never;
  }

  console.log(`  [api] ${method}`);
  return { ok: true, result: true } as never;
});

// ─── Update helpers ──────────────────────────────────────────────────────────

let _updateId = 1;
let _textMsgId = 1;

const fromUser = {
  id: Number(TEST_TELEGRAM_ID),
  is_bot: false,
  first_name: "TestUser",
  username: "testuser",
} as const;

const fromChat = {
  id: Number(TEST_TELEGRAM_ID),
  type: "private" as const,
  first_name: "TestUser",
} as const;

async function cmd(text: string) {
  const cmdPart = text.split(" ")[0];
  console.log(`\n${"─".repeat(62)}`);
  console.log(`> ${text}`);
  console.log(`${"─".repeat(62)}`);

  await bot.handleUpdate({
    update_id: _updateId++,
    message: {
      message_id: _textMsgId++,
      from: fromUser,
      chat: fromChat,
      date: Math.floor(Date.now() / 1000),
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command" as const, offset: 0, length: cmdPart.length }]
        : [],
    },
  });
}

async function tap(callbackData: string) {
  console.log(`\n${"─".repeat(62)}`);
  console.log(`> [TAP] ${callbackData}`);
  console.log(`${"─".repeat(62)}`);

  await bot.handleUpdate({
    update_id: _updateId++,
    callback_query: {
      id: `cb_${Date.now()}`,
      from: fromUser,
      message: {
        message_id: _msgId,
        from: { id: 1, is_bot: true, first_name: "Bot" },
        chat: fromChat,
        date: Math.floor(Date.now() / 1000),
        text: "prev",
      },
      chat_instance: "test",
      data: callbackData,
    },
  });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SuperNova — integration test harness");
  console.log("══════════════════════════════════════════════════════════════\n");

  // ── Setup ──────────────────────────────────────────────────────────────────

  console.log("▶ 1. Loading keypair from TEST_KEYPAIR...");
  const walletAddress = await initTestSigner();
  console.log(`   wallet: ${walletAddress}`);

  console.log("\n▶ 2. Activating Phoenix account (no-op if already done)...");
  try {
    await activatePhoenixAccount(walletAddress);
    console.log("   ✓ activated");
  } catch (e) {
    console.log(`   – skipped: ${(e as Error).message.slice(0, 80)}`);
  }

  console.log("\n▶ 3. Upserting test user in DB...");
  await db
    .insert(users)
    .values({
      id: TEST_TELEGRAM_ID,
      telegramId: TEST_TELEGRAM_ID,
      username: "testuser",
      firstName: "TestUser",
      privyUserId: "test_privy_id",
      walletAddress,
      phoenixActivated: true,
      referralCode: "TESTCODE",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { walletAddress, phoenixActivated: true, updatedAt: new Date() },
    });
  console.log(`   ✓ user ${TEST_TELEGRAM_ID} ready`);

  console.log("\n▶ 4. Initializing bot...");
  await bot.init();
  console.log("   ✓ bot ready");

  // ── Phase 1: Read-only commands ────────────────────────────────────────────

  console.log("\n\n═══════════════════════ PHASE 1: Read-only ═══════════════════════\n");

  await cmd("/balance");
  await sleep(400);

  await cmd("/markets");
  await sleep(400);

  await cmd("/price SOL");
  await sleep(400);

  await cmd("/funding");
  await sleep(400);

  await cmd("/positions");
  await sleep(400);

  // ── Phase 2: Open long position ────────────────────────────────────────────

  console.log("\n\n════════════════════ PHASE 2: Open long position ════════════════════\n");

  const snapshot = await getMarketSnapshot("SOL");
  const markPrice = snapshot.markPrice;
  const usdcSize = (POSITION_SIZE * markPrice) / LEVERAGE;

  console.log(`\n▶ Market snapshot:`);
  console.log(`   Mark price : $${markPrice.toFixed(4)}`);
  console.log(`   Position   : ${POSITION_SIZE} SOL  (${LEVERAGE}x leverage)`);
  console.log(`   Notional   : $${(POSITION_SIZE * markPrice).toFixed(4)}`);
  console.log(`   Collateral : $${usdcSize.toFixed(4)} USDC`);

  await cmd(`/long SOL ${LEVERAGE}x ${usdcSize.toFixed(4)}`);
  await sleep(400);

  if (!lastConfirmCallback) {
    console.error("\n✗ No confirm callback captured — aborting trade phase");
    process.exit(1);
  }

  await tap(lastConfirmCallback);
  lastConfirmCallback = null;

  console.log("\n▶ Waiting 8s for fill...");
  await sleep(8000);

  // ── Phase 3: Position management ──────────────────────────────────────────

  console.log("\n\n══════════════════ PHASE 3: Position management ══════════════════\n");

  await cmd("/positions");
  await sleep(400);

  const slPrice = (markPrice * 0.9).toFixed(4);
  await cmd(`/setsl SOL ${slPrice}`);
  await sleep(600);

  if (lastConfirmCallback) {
    await tap(lastConfirmCallback);
    lastConfirmCallback = null;
    console.log("\n▶ Waiting 4s for SL tx...");
    await sleep(4000);
  }

  const tpPrice = (markPrice * 1.1).toFixed(4);
  await cmd(`/settp SOL ${tpPrice}`);
  await sleep(600);

  if (lastConfirmCallback) {
    await tap(lastConfirmCallback);
    lastConfirmCallback = null;
    console.log("\n▶ Waiting 4s for TP tx...");
    await sleep(4000);
  }

  // ── Phase 4: Close position ────────────────────────────────────────────────

  console.log("\n\n═════════════════════ PHASE 4: Close position ════════════════════\n");

  await tap("close:SOL:100");

  console.log("\n▶ Waiting 8s for close tx...");
  await sleep(8000);

  // ── Phase 5: Verify ────────────────────────────────────────────────────────

  console.log("\n\n══════════════════════════ PHASE 5: Verify ═══════════════════════\n");

  await cmd("/positions");
  await sleep(400);

  await cmd("/balance");
  await sleep(400);

  // Cleanup
  await db.delete(users).where(eq(users.id, TEST_TELEGRAM_ID));
  console.log("\n▶ Test user removed from DB");

  console.log("\n\n══════════════════════════════════════════════════════════════");
  console.log("  ✓ Test complete");
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : String(err));
  console.error(err);
  process.exit(1);
});

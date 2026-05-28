/**
 * Throwaway probe: subscribe to allMids + traderState for one wallet and
 * log one line per emitted message, so we can see WHICH events actually fire
 * (and how often) while the account is idle vs trading.
 *
 * Run:  pnpm exec tsx scripts/ws-probe.ts
 * Stop: Ctrl-C
 */
import "dotenv/config";
import WebSocket from "ws";

const WS_URL = process.env.PHOENIX_WS_URL ?? "wss://perp-api.phoenix.trade/v1/ws";
const WALLET = "HiYGtwBa7UwpJf4XnRDkDmKgRi8QgnM3LAfV23Cmjf6h";

const t = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

const counts: Record<string, number> = {};
let lastTraderStateMs = 0;

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log(`${t()} [open] ${WS_URL}`);
  ws.send(JSON.stringify({ type: "subscribe", subscription: { channel: "allMids" } }));
  ws.send(
    JSON.stringify({
      type: "subscribe",
      // Phoenix expects `authority`, NOT `wallet` (the live server rejects `wallet`
      // with: missing field `authority`, code 400). src/workers/ws.ts currently
      // uses `wallet` — likely a production bug to fix.
      subscription: { channel: "traderState", authority: WALLET, traderPdaIndex: 0 },
    }),
  );
  ws.send(
    JSON.stringify({
      type: "subscribe",
      subscription: { channel: "notifications", authority: WALLET },
    }),
  );
  console.log(`${t()} [sub ] allMids + traderState + notifications (${WALLET.slice(0, 6)}…)`);
});

ws.on("message", (raw) => {
  const text = raw.toString();
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text);
  } catch {
    console.log(`${t()} [raw ] ${text.slice(0, 160)}`);
    return;
  }

  const channel = String(msg.channel ?? msg.type ?? "?");
  counts[channel] = (counts[channel] ?? 0) + 1;

  // traderState: dump the relevant payload (subaccounts for snapshot, deltas for
  // delta) + gap, so we can confirm delta shape, change kinds, and tradeHistory fills.
  if (channel === "traderState") {
    const now = Date.now();
    const gap = lastTraderStateMs ? `${((now - lastTraderStateMs) / 1000).toFixed(1)}s` : "first";
    lastTraderStateMs = now;
    const body = msg.messageType === "delta" ? msg.deltas : msg.subaccounts;
    console.log(
      `${t()} [TS  ] #${counts[channel]} gap=${gap} type=${msg.messageType} slot=${msg.slot}\n${JSON.stringify(body)}`,
    );
    return;
  }

  // notifications: dump full payload so we can see whether Phoenix pushes
  // server-side risk/liquidation/funding events per authority.
  if (channel === "notification" || channel === "notifications") {
    console.log(`${t()} [NOTE] #${counts[channel]} ${JSON.stringify(msg)}`);
    return;
  }

  // allMids: one-liner, just show SOL + how many markets
  if (channel === "allMids") {
    const mids = (msg.mids ?? {}) as Record<string, number>;
    console.log(
      `${t()} [MID ] #${counts[channel]} SOL=${mids.SOL} markets=${Object.keys(mids).length} slot=${msg.slot}`,
    );
    return;
  }

  const keys = Object.keys(msg).join(",");
  console.log(
    `${t()} [msg ] #${counts[channel]} channel=${channel} keys=[${keys}] ${JSON.stringify(msg).slice(0, 180)}`,
  );
});

ws.on("close", () => console.log(`${t()} [close] counts=${JSON.stringify(counts)}`));
ws.on("error", (e) => console.log(`${t()} [error] ${(e as Error).message}`));

process.on("SIGINT", () => {
  console.log(`\n${t()} [exit ] counts=${JSON.stringify(counts)}`);
  ws.close();
  process.exit(0);
});

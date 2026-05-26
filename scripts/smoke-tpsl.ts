import "dotenv/config";
import { config } from "../src/config/index.js";
import { logger } from "../src/lib/logger.js";
import {
  getPositionConditionals,
  type ConditionalRung,
} from "../src/services/phoenix/conditional.js";
import { getTraderState } from "../src/services/phoenix/position.js";
import {
  cancelAllPositionConditionals,
  cancelPositionConditional,
  getFeeConfig,
  setPositionTpSl,
} from "../src/services/phoenix/trade.js";
import { initTestSigner } from "../src/services/wallet.js";

const SYMBOL = process.env.SMOKE_SYMBOL ?? "SOL";

async function expectRungs(
  wallet: string,
  side: "long" | "short",
  predicate: (rungs: ConditionalRung[]) => boolean,
  label: string,
): Promise<ConditionalRung[]> {
  const rungs = await getPositionConditionals(wallet, SYMBOL, side);
  if (!predicate(rungs)) {
    throw new Error(`${label}: predicate failed (got ${rungs.length} rungs)`);
  }
  return rungs;
}

async function main(): Promise<void> {
  if (!config.TEST_KEYPAIR) {
    throw new Error("Set TEST_KEYPAIR (base58 keypair) before running this smoke script.");
  }
  const wallet = await initTestSigner();
  logger.info({ wallet }, "smoke: signer ready");

  const state = await getTraderState(wallet);
  const pos = state.positions[0];
  if (!pos) {
    throw new Error(
      `No open position for wallet ${wallet}. Open a ${SYMBOL} long with placeMarketOrder before running this script.`,
    );
  }
  const side = pos.side;
  logger.info({ symbol: SYMBOL, side, size: pos.size }, "smoke: position located");

  const fee = getFeeConfig("normal", null);
  const mark = Number(pos.markPrice);
  const tp1 = side === "long" ? mark * 1.05 : mark * 0.95;
  const tp2 = side === "long" ? mark * 1.1 : mark * 0.9;
  const sl = side === "long" ? mark * 0.98 : mark * 1.02;

  // Step 1: place a 2-rung TP ladder + single SL — single tx
  logger.info("smoke: setting initial ladder (TP +5% 50% + TP +10% 50% + SL 2% full)");
  await setPositionTpSl(
    {
      symbol: SYMBOL,
      walletAddress: wallet,
      positionSide: side,
      tp: [
        { leg: "tp", triggerPrice: tp1, mode: "limit", size: { kind: "percent", pct: 50 } },
        { leg: "tp", triggerPrice: tp2, mode: "limit", size: { kind: "percent", pct: 50 } },
      ],
      sl: [{ leg: "sl", triggerPrice: sl, mode: "market", size: { kind: "full" } }],
    },
    fee,
  );

  const after1 = await expectRungs(
    wallet,
    side,
    (r) => r.filter((x) => x.leg === "tp").length === 2 && r.filter((x) => x.leg === "sl").length === 1,
    "after-set",
  );
  logger.info({ count: after1.length }, "smoke: ladder placed");

  // Step 2: edit rung 1's price (cancel + place)
  const tpRungs = after1.filter((r) => r.leg === "tp").sort(
    (a, b) => a.conditionalOrderIndex - b.conditionalOrderIndex,
  );
  const first = tpRungs[0];
  const newPrice = side === "long" ? mark * 1.06 : mark * 0.94;
  logger.info({ idx: first.conditionalOrderIndex, newPrice }, "smoke: editing TP rung 1");
  await setPositionTpSl(
    {
      symbol: SYMBOL,
      walletAddress: wallet,
      positionSide: side,
      tp: [
        {
          leg: "tp",
          triggerPrice: newPrice,
          mode: "limit",
          size: { kind: "lots", lots: first.maxSizeLots },
        },
      ],
      cancelTpIndices: [first.conditionalOrderIndex],
    },
    fee,
  );

  await expectRungs(wallet, side, (r) => r.filter((x) => x.leg === "tp").length === 2, "after-edit");

  // Step 3: remove one TP rung
  const after2 = await getPositionConditionals(wallet, SYMBOL, side);
  const toRemove = after2.find((r) => r.leg === "tp");
  if (!toRemove) throw new Error("Expected TP rung to remove");
  logger.info({ idx: toRemove.conditionalOrderIndex }, "smoke: removing one TP rung");
  await cancelPositionConditional(wallet, SYMBOL, side, "tp", toRemove.conditionalOrderIndex, fee);
  await expectRungs(wallet, side, (r) => r.filter((x) => x.leg === "tp").length === 1, "after-remove");

  // Step 4: clear-all SL
  logger.info("smoke: clearing all SL");
  await cancelAllPositionConditionals(wallet, SYMBOL, side, "sl", fee);
  await expectRungs(wallet, side, (r) => r.filter((x) => x.leg === "sl").length === 0, "after-clear-sl");

  // Step 5: final clear of everything
  logger.info("smoke: final clear all");
  await cancelAllPositionConditionals(wallet, SYMBOL, side, "both", fee);
  await expectRungs(wallet, side, (r) => r.length === 0, "after-clear-all");

  logger.info("smoke: ✅ all checks passed");
}

main().catch((err) => {
  logger.error({ err }, "smoke: failed");
  process.exit(1);
});

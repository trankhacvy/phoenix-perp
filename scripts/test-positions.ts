import "dotenv/config";
import { getTraderState } from "../src/services/phoenix/position.js";

const WALLET = process.env.TEST_WALLET ?? "HiYGtwBa7UwpJf4XnRDkDmKgRi8QgnM3LAfV23Cmjf6h";

async function main() {
  const state = await getTraderState(WALLET);
  console.log(`effectiveCollateral $${state.effectiveCollateral}  uPnL $${state.unrealizedPnl}`);
  if (state.positions.length === 0) {
    console.log("No open positions.");
  } else {
    for (const p of state.positions) {
      console.log(`  ${p.symbol} ${p.side} size ${p.size} entry $${p.entryPrice} liq $${p.liquidationPrice}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";

const PHOENIX = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
const DISC = Buffer.from([41, 97, 73, 105, 110, 214, 112, 9]);
const WALLET = process.argv[2] || "HiYGtwBa7UwpJf4XnRDkDmKgRi8QgnM3LAfV23Cmjf6h";

const rpc = process.env.HELIUS_RPC_URL;
if (!rpc) {
  console.log("No HELIUS_RPC_URL");
  process.exit(1);
}

async function main() {
  const conn = new Connection(rpc!, "confirmed");

  const accounts = await conn.getProgramAccounts(PHOENIX, {
    filters: [
      { memcmp: { offset: 0, bytes: DISC.toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 56, bytes: new PublicKey(WALLET).toBase58() } },
    ],
    dataSlice: { offset: 8, length: 148 },
  });

  console.log("Found", accounts.length, "trader PDA(s) for", WALLET);

  for (const { pubkey, account } of accounts) {
    const buf = account.data;
    const lastUpdateSlot = buf.readBigUInt64LE(8);
    const authority = new PublicKey(buf.subarray(48, 80)).toBase58();
    const quoteLotCollateral = buf.readBigInt64LE(80);
    const numMarkets = buf.readUInt16LE(144);
    const pdaIndex = buf[146];
    const subaccountIndex = buf[147];

    console.log("\n--- PDA:", pubkey.toBase58(), "---");
    console.log("authority:", authority);
    console.log("quoteLotCollateral (raw i64):", quoteLotCollateral.toString());
    console.log("  / 1e3 =", (Number(quoteLotCollateral) / 1_000).toFixed(6));
    console.log("  / 1e6 =", (Number(quoteLotCollateral) / 1_000_000).toFixed(6));
    console.log("  / 1e9 =", (Number(quoteLotCollateral) / 1_000_000_000).toFixed(6));
    console.log("numMarketsWithSplines:", numMarkets);
    console.log("traderPdaIndex:", pdaIndex);
    console.log("traderSubaccountIndex:", subaccountIndex);
    console.log("lastUpdateSlot:", lastUpdateSlot.toString());
  }

  const apiUrl = process.env.PHOENIX_API_URL || "https://perp-api.phoenix.trade";
  const res = await fetch(`${apiUrl}/trader/${WALLET}/state`);
  interface TraderView {
    traderSubaccountIndex: number;
    collateralBalance: { ui: string };
    portfolioValue: { ui: string };
    unrealizedPnl: { ui: string };
    positions?: { symbol: string }[];
  }
  const data = (await res.json()) as { traders?: TraderView[] };

  console.log("\n=== REST API comparison ===");
  for (const t of data.traders ?? []) {
    console.log("\nsubaccount:", t.traderSubaccountIndex);
    console.log("collateralBalance.ui:", t.collateralBalance.ui);
    console.log("portfolioValue.ui:", t.portfolioValue.ui);
    console.log("unrealizedPnl.ui:", t.unrealizedPnl.ui);
    console.log("positions:", (t.positions ?? []).length);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

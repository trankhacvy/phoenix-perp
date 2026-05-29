import type { CustomSubscriptionDefinition } from "@ellipsis-labs/rise";
import { z } from "zod";
import { getPhoenixWsClient } from "./client.js";
import { superviseFeed } from "./feed-supervisor.js";

const tradesMsgSchema = z.object({
  channel: z.literal("trades"),
  symbol: z.string(),
  trades: z.array(z.object({ taker: z.string().optional() })).default([]),
});

type TradesMsg = z.infer<typeof tradesMsgSchema>;

interface TakersUpdate {
  takers: string[];
}

type TradesDefinition = CustomSubscriptionDefinition<TradesMsg, TakersUpdate, [string]>;

let _adapter: ((symbol: string, signal?: AbortSignal) => AsyncIterable<TakersUpdate>) | null = null;

function getAdapter() {
  if (_adapter) return _adapter;
  const definition: TradesDefinition = {
    subscriptionChannel: "trades",
    // Rise bundles zod v4; this project uses zod v3. Runtime-compatible (both
    // expose parse/safeParse), so only the schema field needs a bridging cast.
    schema: tradesMsgSchema as unknown as TradesDefinition["schema"],
    buildKey: (symbol) => `trades:${symbol.toUpperCase()}`,
    buildSubParams: (symbol) => ({ symbol: symbol.toUpperCase() }),
    getKeyFromMessage: (m) => `trades:${m.symbol.toUpperCase()}`,
    processMessage: (m) => ({
      takers: m.trades
        .map((t) => t.taker)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
    }),
  };
  _adapter = getPhoenixWsClient().registerSubscription(definition);
  return _adapter;
}

export function subscribeMarketTakers(
  symbol: string,
  onTaker: (taker: string) => void,
): () => void {
  const ac = new AbortController();
  void superviseFeed(`trades:${symbol.toUpperCase()}`, ac.signal, async (onAlive) => {
    for await (const update of getAdapter()(symbol, ac.signal)) {
      onAlive();
      for (const taker of update.takers) onTaker(taker);
    }
  });
  return () => ac.abort();
}

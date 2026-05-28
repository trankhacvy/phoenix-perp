import { logger } from "../../lib/logger.js";
import { getPhoenixWsClient } from "./client.js";

type TickFn = (mids: ReadonlyMap<string, number>) => void | Promise<void>;

const mids = new Map<string, number>();
const subscribers = new Set<TickFn>();
let controller: AbortController | null = null;

export function getMid(symbol: string): number | undefined {
  return mids.get(symbol.toUpperCase());
}

export function onMids(fn: TickFn): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function startPriceFeed(): void {
  if (controller) return;
  const ac = new AbortController();
  controller = ac;
  void (async () => {
    for await (const update of getPhoenixWsClient().allMids(ac.signal)) {
      for (const [symbol, price] of Object.entries(update.mids)) {
        mids.set(symbol.toUpperCase(), price);
      }
      for (const fn of subscribers) {
        Promise.resolve(fn(mids)).catch((err) => logger.error({ err }, "mids subscriber failed"));
      }
    }
  })().catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return;
    logger.error({ err }, "allMids subscription failed");
  });
}

export function stopPriceFeed(): void {
  controller?.abort();
  controller = null;
}

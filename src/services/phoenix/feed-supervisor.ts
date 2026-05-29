import { logger } from "../../lib/logger.js";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === "AbortError");
}

/**
 * Keep a WebSocket consumer loop alive. The Rise SDK reconnects internally, but if
 * the async iterator itself ends or throws, the `for await` simply stops and the feed
 * goes silently dead. This wrapper re-enters `body` (which should consume the iterator)
 * with exponential backoff until the signal aborts — so a dropped feed self-heals
 * instead of freezing all downstream prices/alerts.
 *
 * `body` should call `onAlive()` whenever it receives a message; that resets the
 * backoff so a long-lived feed that briefly blips recovers fast.
 */
export async function superviseFeed(
  name: string,
  signal: AbortSignal,
  body: (onAlive: () => void) => Promise<void>,
): Promise<void> {
  let backoff = BACKOFF_BASE_MS;
  while (!signal.aborted) {
    const onAlive = () => {
      backoff = BACKOFF_BASE_MS;
    };
    try {
      await body(onAlive);
      if (signal.aborted) break;
      logger.warn({ feed: name }, "WS feed stream ended unexpectedly, restarting");
    } catch (err) {
      if (isAbort(err, signal)) break;
      logger.error({ feed: name, err }, "WS feed errored, restarting");
    }
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

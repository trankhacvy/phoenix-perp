export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryIf?: (err: unknown) => boolean;
}

function isRateLimitError(msg: string): boolean {
  return /rate.?limit|429|too many requests/i.test(msg);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 1000, maxDelayMs = 30_000, retryIf } = opts;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = isRateLimitError(msg);
      const isRetryable = retryIf
        ? retryIf(err)
        : rateLimited || /network|ECONNRESET|timeout|ETIMEDOUT|fetch failed/i.test(msg);

      if (!isRetryable || i === attempts - 1) break;

      // Rate limits get a heavier base; equal jitter spreads retries to avoid thundering herd.
      const base = rateLimited ? baseDelayMs * 3 : baseDelayMs;
      const capped = Math.min(base * 2 ** i, maxDelayMs);
      const delay = capped / 2 + Math.floor(Math.random() * (capped / 2));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  retryIf?: (err: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 1000, retryIf } = opts;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = retryIf
        ? retryIf(err)
        : /rate.?limit|429|network|ECONNRESET|timeout|ETIMEDOUT|fetch failed/i.test(msg);

      if (!isRetryable || i === attempts - 1) break;

      const delay = baseDelayMs * 2 ** i;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

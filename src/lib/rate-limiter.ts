/**
 * In-memory token bucket for throttling outbound API calls.
 * Worker uses this to stay under Phoenix API rate limits
 * without starving bot commands.
 */
export class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private lastRefill: number;
  private waitQueue: (() => void)[] = [];

  constructor(maxTokens: number, refillPerSecond: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRatePerMs = refillPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      setTimeout(() => {
        this.refill();
        this.tokens -= 1;
        const idx = this.waitQueue.indexOf(resolve);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        resolve();
      }, waitMs);
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }

  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

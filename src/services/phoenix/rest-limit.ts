import { TokenBucket } from "../../lib/rate-limiter.js";

// Phoenix REST 429s around ~5 req/s. Cap read-side calls below that: burst 4,
// sustained 3/s. Worker-specific buckets (leaderboard, rest-refresh) stack on top.
const bucket = new TokenBucket(4, 3);

export async function acquirePhoenixRest(): Promise<void> {
  await bucket.acquire();
}

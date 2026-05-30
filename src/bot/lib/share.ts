import { config } from "../../config/index.js";
import type { PnlCardData } from "../../services/image.js";
import { pct, signedUsd } from "./fmt.js";

/** Public origin used for shareable card links. null when none is configured. */
export function publicBaseUrl(): string | null {
  const base = config.PUBLIC_URL ?? config.WEBHOOK_URL;
  return base ? base.replace(/\/$/, "") : null;
}

/** Card landing page (carries Twitter Card meta → image unfurls in the tweet). */
export function cardPageUrl(token: string): string | null {
  const base = publicBaseUrl();
  return base ? `${base}/card/${token}` : null;
}

/** Raw PNG endpoint, re-rendered on demand from the stashed card token. */
export function cardImageUrl(token: string): string | null {
  const base = publicBaseUrl();
  return base ? `${base}/card/${token}/image.png` : null;
}

/**
 * X (Twitter) composer deep link. X appends `url` after `text` and unfurls it,
 * so `linkUrl` should be the card page when a public URL exists (image in tweet),
 * or the referral link as a fallback (text-only).
 */
export function tweetIntentUrl(data: PnlCardData, linkUrl: string): string {
  const dir = data.side.toUpperCase();
  const emoji = data.pnlUsdc >= 0 ? "📈" : "📉";
  const text = `${emoji} Closed ${dir} ${data.symbol} — ${pct(data.roiPercent)} ROI (${signedUsd(data.pnlUsdc)})

Trading perps on Solana, right inside Telegram.`;
  const params = new URLSearchParams({ text, url: linkUrl });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

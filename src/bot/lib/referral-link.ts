import type { ReferralBadge } from "../../services/image.js";
import type { BotContext } from "../../types/index.js";

/**
 * Build the user's shareable bot link. Carries the `?start=<code>` referral
 * payload when the user has a code; falls back to the plain bot link otherwise.
 */
export function referralLink(ctx: BotContext): string | null {
  const username = ctx.me?.username;
  if (!username) return null;
  const code = ctx.user?.referralCode;
  return code ? `https://t.me/${username}?start=${code}` : `https://t.me/${username}`;
}

/**
 * Referral badge (QR url + label) embedded on share cards. Falls back to the
 * plain bot handle when there's no referral code, so cards always carry a
 * scannable link.
 */
export function referralBadgeData(ctx: BotContext): ReferralBadge | undefined {
  const username = ctx.me?.username;
  if (!username) return undefined;
  const code = ctx.user?.referralCode;
  return code
    ? { url: `https://t.me/${username}?start=${code}`, code }
    : { url: `https://t.me/${username}`, code: `@${username}` };
}

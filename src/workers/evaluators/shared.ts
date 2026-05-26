import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";

export function esc(s: string | number): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ALERT_ENABLED_DEFAULTS: Record<string, boolean> = {
  at_risk: true,
  cancellable: true,
  liquidatable: true,
  tpsl_flip: true,
};

const ALERT_ENABLED_CACHE_TTL_MS = 30_000;
const _alertEnabledCache = new Map<string, { enabled: boolean; ts: number }>();

type AlertTypeValue = (typeof alertSubscriptions.type.enumValues)[number];

export async function isAlertEnabled(userId: string, alertType: string): Promise<boolean> {
  const cacheKey = `${userId}:${alertType}`;
  const cached = _alertEnabledCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ALERT_ENABLED_CACHE_TTL_MS) return cached.enabled;

  const row = await db.query.alertSubscriptions.findFirst({
    where: and(
      eq(alertSubscriptions.userId, userId),
      eq(alertSubscriptions.type, alertType as AlertTypeValue),
      isNull(alertSubscriptions.symbol),
    ),
  });

  const enabled = row ? row.enabled : (ALERT_ENABLED_DEFAULTS[alertType] ?? true);
  _alertEnabledCache.set(cacheKey, { enabled, ts: Date.now() });
  return enabled;
}

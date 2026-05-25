import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { userSettings } from "../db/schema/index.js";

export type FeeMode = "eco" | "normal" | "turbo" | "custom";

export interface Settings {
  slippageBps: number;
  defaultLeverage: number;
  confirmTrades: boolean;
  confirmClose: boolean;
  feeMode: FeeMode;
  customFeeSol: number | null;
  autoTpPct: number | null;
  autoSlPct: number | null;
}

const DEFAULTS: Settings = {
  slippageBps: 50,
  defaultLeverage: 5,
  confirmTrades: true,
  confirmClose: true,
  feeMode: "normal",
  customFeeSol: null,
  autoTpPct: null,
  autoSlPct: null,
};

export async function getSettings(userId: string): Promise<Settings> {
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!row) return DEFAULTS;
  return {
    slippageBps: row.slippageBps,
    defaultLeverage: row.defaultLeverage,
    confirmTrades: row.confirmTrades,
    confirmClose: row.confirmClose,
    feeMode: row.feeMode as FeeMode,
    customFeeSol: row.customFeeSol ? Number(row.customFeeSol) : null,
    autoTpPct: row.autoTpPct ? Number(row.autoTpPct) : null,
    autoSlPct: row.autoSlPct ? Number(row.autoSlPct) : null,
  };
}

function toDbRow(s: Settings) {
  return {
    slippageBps: s.slippageBps,
    defaultLeverage: s.defaultLeverage,
    confirmTrades: s.confirmTrades,
    confirmClose: s.confirmClose,
    feeMode: s.feeMode,
    customFeeSol: s.customFeeSol?.toFixed(9) ?? null,
    autoTpPct: s.autoTpPct?.toFixed(2) ?? null,
    autoSlPct: s.autoSlPct?.toFixed(2) ?? null,
  };
}

export async function saveSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(userId);
  const merged = { ...current, ...patch };
  const row = toDbRow(merged);

  await db
    .insert(userSettings)
    .values({ userId, ...row })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...row, updatedAt: new Date() },
    });
  return merged;
}

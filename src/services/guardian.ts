import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { type GuardianRule, type NewGuardianRule, guardianRules } from "../db/schema/index.js";

const MAX_RULES_PER_USER = 20;

const _rulesCache = new Map<string, { rules: GuardianRule[]; ts: number }>();
const CACHE_TTL_MS = 30_000;

export function generateRuleId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export async function getActiveRules(userId: string): Promise<GuardianRule[]> {
  const cached = _rulesCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rules;

  const rules = await db.query.guardianRules.findMany({
    where: and(eq(guardianRules.userId, userId), eq(guardianRules.enabled, true)),
  });

  _rulesCache.set(userId, { rules, ts: Date.now() });
  return rules;
}

export function invalidateRulesCache(userId: string) {
  _rulesCache.delete(userId);
}

export async function getUserRules(userId: string): Promise<GuardianRule[]> {
  return db.query.guardianRules.findMany({
    where: eq(guardianRules.userId, userId),
    orderBy: (r, { desc }) => [desc(r.createdAt)],
  });
}

export async function createRule(rule: NewGuardianRule): Promise<GuardianRule> {
  const existing = await db.query.guardianRules.findMany({
    where: eq(guardianRules.userId, rule.userId),
  });
  if (existing.length >= MAX_RULES_PER_USER) {
    throw new Error(`Maximum ${MAX_RULES_PER_USER} rules allowed.`);
  }

  const [created] = await db.insert(guardianRules).values(rule).returning();
  invalidateRulesCache(rule.userId);
  return created;
}

export async function updateRule(
  ruleId: string,
  userId: string,
  patch: Partial<
    Pick<GuardianRule, "threshold" | "direction" | "action" | "actionParam" | "enabled">
  >,
): Promise<GuardianRule | null> {
  const [updated] = await db
    .update(guardianRules)
    .set(patch)
    .where(and(eq(guardianRules.id, ruleId), eq(guardianRules.userId, userId)))
    .returning();
  if (updated) invalidateRulesCache(userId);
  return updated ?? null;
}

export async function toggleRule(ruleId: string, userId: string): Promise<GuardianRule | null> {
  const rule = await db.query.guardianRules.findFirst({
    where: and(eq(guardianRules.id, ruleId), eq(guardianRules.userId, userId)),
  });
  if (!rule) return null;

  const [updated] = await db
    .update(guardianRules)
    .set({ enabled: !rule.enabled })
    .where(eq(guardianRules.id, ruleId))
    .returning();
  invalidateRulesCache(userId);
  return updated;
}

export async function deleteAllRules(userId: string): Promise<number> {
  const deleted = await db
    .delete(guardianRules)
    .where(eq(guardianRules.userId, userId))
    .returning({ id: guardianRules.id });
  invalidateRulesCache(userId);
  return deleted.length;
}

export async function deleteRule(ruleId: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(guardianRules)
    .where(and(eq(guardianRules.id, ruleId), eq(guardianRules.userId, userId)))
    .returning({ id: guardianRules.id });
  invalidateRulesCache(userId);
  return deleted.length > 0;
}

export async function markTriggered(ruleId: string, userId?: string) {
  await db
    .update(guardianRules)
    .set({ lastTriggeredAt: new Date() })
    .where(eq(guardianRules.id, ruleId));
  if (userId) invalidateRulesCache(userId);
}

export async function disableAllAutoActions(userId: string): Promise<number> {
  const autoActions = ["auto_close", "auto_reduce", "auto_margin"] as const;
  const updated = await db
    .update(guardianRules)
    .set({ action: "suggest" })
    .where(and(eq(guardianRules.userId, userId), inArray(guardianRules.action, [...autoActions])))
    .returning({ id: guardianRules.id });
  invalidateRulesCache(userId);
  return updated.length;
}

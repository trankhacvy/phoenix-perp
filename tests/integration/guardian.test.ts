import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { guardianRules, users } from "../../src/db/schema/index.js";
import {
  createRule,
  deleteRule,
  disableAllAutoActions,
  generateRuleId,
  getUserRules,
  invalidateRulesCache,
  toggleRule,
} from "../../src/services/guardian.js";

const USER_ID = `grd-integ-${Date.now()}`;

const testUser = {
  id: USER_ID,
  telegramId: USER_ID,
  privyUserId: `privy-${USER_ID}`,
  walletAddress: `wallet-${USER_ID}`,
  phoenixActivated: true as const,
};

describe("guardian rules CRUD", () => {
  beforeAll(async () => {
    await db.insert(users).values(testUser).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(guardianRules).where(eq(guardianRules.userId, USER_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
    invalidateRulesCache(USER_ID);
  });

  it("creates a rule and retrieves it", async () => {
    invalidateRulesCache(USER_ID);
    const id = generateRuleId();
    const rule = await createRule({
      id,
      userId: USER_ID,
      ruleType: "liq_distance",
      symbol: "SOL",
      threshold: "10",
      direction: "below",
      action: "suggest",
    });

    expect(rule.ruleType).toBe("liq_distance");
    expect(rule.symbol).toBe("SOL");
    expect(rule.enabled).toBe(true);

    const all = await getUserRules(USER_ID);
    expect(all.some((r) => r.id === id)).toBe(true);

    await deleteRule(id, USER_ID);
  });

  it("toggles a rule enabled/disabled", async () => {
    invalidateRulesCache(USER_ID);
    const id = generateRuleId();
    const rule = await createRule({
      id,
      userId: USER_ID,
      ruleType: "drawdown",
      threshold: "15",
      direction: "above",
      action: "notify",
    });

    expect(rule.enabled).toBe(true);

    const toggled = await toggleRule(id, USER_ID);
    expect(toggled?.enabled).toBe(false);

    const toggledBack = await toggleRule(id, USER_ID);
    expect(toggledBack?.enabled).toBe(true);

    await deleteRule(id, USER_ID);
  });

  it("deletes a rule", async () => {
    invalidateRulesCache(USER_ID);
    const id = generateRuleId();
    await createRule({
      id,
      userId: USER_ID,
      ruleType: "pnl_target",
      threshold: "50",
      direction: "above",
      action: "suggest",
    });

    const deleted = await deleteRule(id, USER_ID);
    expect(deleted).toBe(true);

    const found = (await getUserRules(USER_ID)).find((r) => r.id === id);
    expect(found).toBeUndefined();
  });

  it("returns false when deleting non-existent rule", async () => {
    const deleted = await deleteRule("nonexistent", USER_ID);
    expect(deleted).toBe(false);
  });

  it("returns null when toggling non-existent rule", async () => {
    const result = await toggleRule("nonexistent", USER_ID);
    expect(result).toBeNull();
  });

  it("enforces max rules per user", async () => {
    invalidateRulesCache(USER_ID);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = generateRuleId();
      ids.push(id);
      await createRule({
        id,
        userId: USER_ID,
        ruleType: "liq_distance",
        threshold: String(i + 1),
        direction: "below",
        action: "notify",
      });
    }

    await expect(
      createRule({
        id: generateRuleId(),
        userId: USER_ID,
        ruleType: "liq_distance",
        threshold: "99",
        direction: "below",
        action: "notify",
      }),
    ).rejects.toThrow("Maximum 20 rules allowed");

    for (const id of ids) {
      await deleteRule(id, USER_ID);
    }
  });

  it("disableAllAutoActions downgrades only auto rules", async () => {
    invalidateRulesCache(USER_ID);
    const notifyId = generateRuleId();
    const autoId = generateRuleId();
    const autoReduceId = generateRuleId();

    await createRule({
      id: notifyId,
      userId: USER_ID,
      ruleType: "liq_distance",
      threshold: "10",
      direction: "below",
      action: "notify",
    });

    await createRule({
      id: autoId,
      userId: USER_ID,
      ruleType: "pnl_target",
      threshold: "50",
      direction: "above",
      action: "auto_close",
    });

    await createRule({
      id: autoReduceId,
      userId: USER_ID,
      ruleType: "exposure_limit",
      threshold: "50000",
      direction: "above",
      action: "auto_reduce",
      actionParam: "50",
    });

    const count = await disableAllAutoActions(USER_ID);
    expect(count).toBe(2);

    const all = await getUserRules(USER_ID);
    const byId = (id: string) => all.find((r) => r.id === id);

    expect(byId(notifyId)?.action).toBe("notify");
    expect(byId(autoId)?.action).toBe("suggest");
    expect(byId(autoReduceId)?.action).toBe("suggest");

    await deleteRule(notifyId, USER_ID);
    await deleteRule(autoId, USER_ID);
    await deleteRule(autoReduceId, USER_ID);
  });

  it("prevents cross-user access on delete", async () => {
    invalidateRulesCache(USER_ID);
    const id = generateRuleId();
    await createRule({
      id,
      userId: USER_ID,
      ruleType: "liq_distance",
      threshold: "10",
      direction: "below",
      action: "notify",
    });

    const deleted = await deleteRule(id, "other-user-id");
    expect(deleted).toBe(false);

    const found = (await getUserRules(USER_ID)).find((r) => r.id === id);
    expect(found).toBeDefined();

    await deleteRule(id, USER_ID);
  });
});

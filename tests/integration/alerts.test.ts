import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { alertSubscriptions, users } from "../../src/db/schema/index.js";

const testUser = {
  id: "test-user-1",
  telegramId: "test-user-1",
  privyUserId: "privy-test-1",
  walletAddress: "wallet-test-1",
  phoenixActivated: true as const,
};

describe("alerts system", () => {
  beforeEach(async () => {
    await db.delete(alertSubscriptions);
    await db.delete(users);
    await db.insert(users).values(testUser);
  });

  afterEach(async () => {
    await db.delete(alertSubscriptions);
    await db.delete(users);
  });

  it("toggles only the targeted alert type", async () => {
    const atRiskId = crypto.randomUUID();
    const fillId = crypto.randomUUID();

    await db.insert(alertSubscriptions).values([
      { id: atRiskId, userId: testUser.id, type: "at_risk", enabled: true },
      { id: fillId, userId: testUser.id, type: "fill", enabled: true },
    ]);

    const existing = await db.query.alertSubscriptions.findFirst({
      where: and(
        eq(alertSubscriptions.userId, testUser.id),
        eq(alertSubscriptions.type, "fill"),
      ),
    });
    expect(existing).toBeDefined();

    await db
      .update(alertSubscriptions)
      .set({ enabled: !existing!.enabled })
      .where(eq(alertSubscriptions.id, existing!.id));

    const updatedFill = await db.query.alertSubscriptions.findFirst({
      where: eq(alertSubscriptions.id, fillId),
    });
    const untouchedAtRisk = await db.query.alertSubscriptions.findFirst({
      where: eq(alertSubscriptions.id, atRiskId),
    });

    expect(updatedFill?.enabled).toBe(false);
    expect(untouchedAtRisk?.enabled).toBe(true);
  });

  it("inserts a new row when no existing subscription for type", async () => {
    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId: testUser.id,
      type: "at_risk",
      enabled: false,
    });

    const existing = await db.query.alertSubscriptions.findFirst({
      where: and(
        eq(alertSubscriptions.userId, testUser.id),
        eq(alertSubscriptions.type, "fill"),
      ),
    });
    expect(existing).toBeUndefined();
  });
});

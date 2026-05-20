import { describe, expect, it } from "vitest";
import { generatePnlCard } from "../../../src/services/image.js";

describe("generatePnlCard", () => {
  it("returns a non-empty Buffer for a profit trade", async () => {
    const buf = await generatePnlCard({
      symbol: "SOL",
      side: "long",
      entryPrice: "100.00",
      exitPrice: "150.00",
      roiPercent: "+50.0",
      pnlUsdc: "+500.00",
      botHandle: "@TestBot",
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("returns a non-empty Buffer for a loss trade", async () => {
    const buf = await generatePnlCard({
      symbol: "BTC",
      side: "short",
      entryPrice: "60000.00",
      exitPrice: "65000.00",
      roiPercent: "-8.3",
      pnlUsdc: "-500.00",
      botHandle: "@TestBot",
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });
});

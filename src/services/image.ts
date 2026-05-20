import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_PATH = join(__dirname, "../../assets/fonts/Inter-Bold.ttf");

let _fontData: ArrayBuffer | null = null;
function getFontData(): ArrayBuffer {
  if (!_fontData) {
    _fontData = readFileSync(FONT_PATH).buffer as ArrayBuffer;
  }
  return _fontData;
}

export interface PnlCardData {
  symbol: string;
  side: "long" | "short";
  entryPrice: string;
  exitPrice: string;
  roiPercent: string;
  pnlUsdc: string;
  botHandle: string;
}

export async function generatePnlCard(data: PnlCardData): Promise<Buffer> {
  const isProfit = !data.roiPercent.startsWith("-");
  const sideColor = data.side === "long" ? "#22c55e" : "#ef4444";
  const pnlColor = isProfit ? "#22c55e" : "#ef4444";

  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "column",
          width: "1200px",
          height: "630px",
          background: "#0f172a",
          padding: "60px",
          fontFamily: "Inter",
          color: "#f8fafc",
          justifyContent: "space-between",
        },
        children: [
          {
            type: "div",
            props: {
              style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
              children: [
                {
                  type: "div",
                  props: {
                    style: { fontSize: 48, fontWeight: 700 },
                    children: `${data.symbol} ${data.side.toUpperCase()}`,
                  },
                },
                {
                  type: "div",
                  props: {
                    style: {
                      background: sideColor,
                      color: "#fff",
                      padding: "8px 24px",
                      borderRadius: 8,
                      fontSize: 28,
                    },
                    children: data.side.toUpperCase(),
                  },
                },
              ],
            },
          },
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column", gap: "16px" },
              children: [
                {
                  type: "div",
                  props: {
                    style: { fontSize: 96, fontWeight: 700, color: pnlColor },
                    children: `${data.roiPercent}%`,
                  },
                },
                {
                  type: "div",
                  props: {
                    style: { fontSize: 40, color: "#94a3b8" },
                    children: `${data.pnlUsdc} USDC`,
                  },
                },
              ],
            },
          },
          {
            type: "div",
            props: {
              style: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" },
              children: [
                {
                  type: "div",
                  props: {
                    style: { display: "flex", gap: "48px", fontSize: 28, color: "#94a3b8" },
                    children: [
                      {
                        type: "div",
                        props: { children: `Entry  $${data.entryPrice}` },
                      },
                      {
                        type: "div",
                        props: { children: `Exit  $${data.exitPrice}` },
                      },
                    ],
                  },
                },
                {
                  type: "div",
                  props: {
                    style: { fontSize: 24, color: "#6366f1" },
                    children: `Trade on ${data.botHandle}`,
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [{ name: "Inter", data: getFontData(), weight: 700, style: "normal" }],
    },
  );

  return sharp(Buffer.from(svg)).png().toBuffer();
}

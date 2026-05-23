import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, "../../assets");
const FONT_PATH = join(ASSETS, "fonts/Inter-Bold.ttf");

// ── Fonts ─────────────────────────────────────────────────────────────────────

let _fontData: ArrayBuffer | null = null;

function getFont(): ArrayBuffer {
  if (!_fontData) {
    _fontData = readFileSync(FONT_PATH).buffer as ArrayBuffer;
  }
  return _fontData;
}

// ── Background images ─────────────────────────────────────────────────────────

const bgCache = new Map<string, string>();

function getBg(win: boolean): string {
  const key = win ? "win" : "lost";
  if (!bgCache.has(key)) {
    const data = readFileSync(join(ASSETS, `${key}.jpg`));
    bgCache.set(key, `data:image/jpeg;base64,${data.toString("base64")}`);
  }
  return bgCache.get(key) as string;
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const FF = "SpaceGrotesk";

const C = {
  bg: "#05050f",
  label: "#484858",
  text: "#efefef",
  muted: "#7a7a8a",
  profit: "#22c55e",
  loss: "#ef4444",
  divider: "rgba(255,255,255,0.07)",
  barBg: "rgba(2,2,10,0.82)",
  credit: "#3d3d50",
};

// Gradient: opaque dark on the left, transparent on the right to reveal the phoenix image
const OVERLAY =
  "linear-gradient(to right, rgba(5,5,15,0.98) 0%, rgba(5,5,15,0.95) 45%, rgba(5,5,15,0.62) 65%, rgba(5,5,15,0.1) 86%, transparent 100%)";

const W = 1200;
const H = 630;
const BAR_H = 72;
const PANEL_W = 615;
const PAD_L = 60;
const PAD_T = 32;

// ── Element helpers ───────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: satori object tree nodes
type Node = { type: string; props: Record<string, any> };

function lbl(text: string): Node {
  return {
    type: "div",
    props: {
      style: {
        fontFamily: FF,
        fontSize: 11,
        fontWeight: 400,
        color: C.label,
        letterSpacing: 2.5,
        textTransform: "uppercase",
      },
      children: text,
    },
  };
}

function txt(text: string, size: number, color: string = C.text, weight: 400 | 700 = 700): Node {
  return {
    type: "div",
    props: {
      style: { fontFamily: FF, fontSize: size, fontWeight: weight, color, lineHeight: 1.05 },
      children: text,
    },
  };
}

function field(labelText: string, valueText: string, size: number, color?: string): Node {
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", gap: 7 },
      children: [lbl(labelText), txt(valueText, size, color)],
    },
  };
}

function statItem(labelText: string, valueText: string, valueColor: string = C.text): Node {
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5 },
      children: [
        {
          type: "div",
          props: {
            style: {
              fontFamily: FF,
              fontSize: 10,
              fontWeight: 400,
              color: C.label,
              letterSpacing: 2,
              textTransform: "uppercase",
            },
            children: labelText,
          },
        },
        {
          type: "div",
          props: {
            style: { fontFamily: FF, fontSize: 19, fontWeight: 700, color: valueColor },
            children: valueText,
          },
        },
      ],
    },
  };
}

const vDivider: Node = {
  type: "div",
  props: { style: { width: 1, height: 28, background: C.divider, alignSelf: "center" } },
};

function directionBadge(side: "long" | "short", leverage?: number): Node {
  const isLong = side === "long";
  const color = isLong ? C.profit : C.loss;
  const bg = isLong ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)";
  const pillChildren: Node[] = [
    {
      type: "div",
      props: {
        style: { fontFamily: FF, fontSize: 15, fontWeight: 700, color },
        children: isLong ? "▲" : "▼",
      },
    },
    {
      type: "div",
      props: {
        style: { fontFamily: FF, fontSize: 15, fontWeight: 700, color },
        children: isLong ? "LONG" : "SHORT",
      },
    },
  ];
  const rowChildren: Node[] = [
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          background: bg,
          border: `1.5px solid ${color}`,
          borderRadius: 8,
          padding: "7px 16px",
        },
        children: pillChildren,
      },
    },
  ];
  if (leverage !== undefined) {
    rowChildren.push(txt(`${leverage}×`, 17, C.muted));
  }
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "row", alignItems: "center", gap: 14 },
      children: rowChildren,
    },
  };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const fmt =
    abs >= 1_000_000
      ? `$${(abs / 1_000_000).toFixed(2)}M`
      : abs >= 1_000
        ? `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `$${abs.toFixed(2)}`;
  return n >= 0 ? `+${fmt}` : `-${fmt}`;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const s =
    abs >= 1_000_000
      ? `$${(abs / 1_000_000).toFixed(1)}M`
      : abs >= 1_000
        ? `$${Math.round(abs / 1_000)}K`
        : `$${Math.round(abs)}`;
  return n >= 0 ? s : `-${s}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ── Shared card shell ─────────────────────────────────────────────────────────

function cardShell(win: boolean, leftContent: Node[], barItems: Node[]): Node {
  return {
    type: "div",
    props: {
      style: {
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: W,
        height: H,
        background: C.bg,
        overflow: "hidden",
        fontFamily: FF,
      },
      children: [
        // Background image — right-side focused
        {
          type: "img",
          props: {
            src: getBg(win),
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width: W,
              height: H,
              objectFit: "cover",
              objectPosition: "right center",
            },
          },
        },
        // Dark overlay — fades left→right so left text stays readable
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width: W,
              height: H,
              background: OVERLAY,
            },
          },
        },
        // Content layer
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width: W,
              height: H,
              display: "flex",
              flexDirection: "column",
            },
            children: [
              // Credit — top right
              {
                type: "div",
                props: {
                  style: { display: "flex", justifyContent: "flex-end", padding: "20px 36px 0" },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: { fontFamily: FF, fontSize: 12, fontWeight: 400, color: C.credit },
                        children: "Created by @trankhac_vy",
                      },
                    },
                  ],
                },
              },
              // Main row
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "row", flex: 1 },
                  children: [
                    // Left panel
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          gap: 24,
                          width: PANEL_W,
                          padding: `${PAD_T}px 0 ${PAD_T}px ${PAD_L}px`,
                        },
                        children: leftContent,
                      },
                    },
                    // Right spacer — transparent, phoenix image shows through
                    { type: "div", props: { style: { flex: 1 } } },
                  ],
                },
              },
              // Bottom stats bar
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-around",
                    height: BAR_H,
                    background: C.barBg,
                    borderTop: `1px solid ${C.divider}`,
                    paddingLeft: 48,
                    paddingRight: 48,
                  },
                  children: barItems,
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// ── PnL Card ──────────────────────────────────────────────────────────────────

export interface PnlCardData {
  symbol: string;
  side: "long" | "short";
  leverage?: number;
  entryPrice: string;
  exitPrice: string;
  roiPercent: number;
  pnlUsdc: number;
  duration?: string;
  size?: string;
}

export async function generatePnlCard(data: PnlCardData): Promise<Buffer> {
  const win = data.pnlUsdc >= 0;
  const accent = win ? C.profit : C.loss;

  const leftContent: Node[] = [
    field("Market", data.symbol, 52),
    directionBadge(data.side, data.leverage),
    field("Realized PnL", fmtUsd(data.pnlUsdc), 74, accent),
    txt(fmtPct(data.roiPercent), 44, accent),
  ];

  const barItems: Node[] = [];
  const addStat = (l: string, v: string, color?: string) => {
    if (barItems.length > 0) barItems.push(vDivider);
    barItems.push(statItem(l, v, color));
  };

  addStat("Entry", `$${data.entryPrice}`);
  addStat("Exit", `$${data.exitPrice}`);
  if (data.size) addStat("Size", data.size);
  if (data.duration) addStat("Duration", data.duration);

  const svg = await satori(cardShell(win, leftContent, barItems), {
    width: W,
    height: H,
    fonts: [
      { name: FF, data: getFont(), weight: 400, style: "normal" },
      { name: FF, data: getFont(), weight: 700, style: "normal" },
    ],
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── Wallet Summary Card ───────────────────────────────────────────────────────

export interface WalletCardData {
  walletAddress: string;
  realizedPnl: number;
  winRate: number | null;
  totalFills: number;
  totalVolume: number;
  bestTrade: { pnl: number; symbol: string } | null;
  worstTrade: { pnl: number; symbol: string } | null;
}

export async function generateWalletCard(data: WalletCardData): Promise<Buffer> {
  const win = data.realizedPnl >= 0;
  const accent = win ? C.profit : C.loss;

  const leftContent: Node[] = [
    field("Trader", shortAddr(data.walletAddress), 28, C.muted),
    field("Total PnL", fmtUsd(data.realizedPnl), 74, accent),
  ];

  if (data.winRate !== null) {
    leftContent.push(field("Win Rate", `${Math.round(data.winRate)}%`, 48));
  }

  if (data.bestTrade && data.worstTrade) {
    leftContent.push({
      type: "div",
      props: {
        style: { display: "flex", flexDirection: "row", gap: 40 },
        children: [
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column", gap: 6 },
              children: [lbl("Best Trade"), txt(fmtUsd(data.bestTrade.pnl), 22, C.profit)],
            },
          },
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column", gap: 6 },
              children: [lbl("Worst Trade"), txt(fmtUsd(data.worstTrade.pnl), 22, C.loss)],
            },
          },
        ],
      },
    });
  }

  const barItems: Node[] = [];
  const addStat = (l: string, v: string, color?: string) => {
    if (barItems.length > 0) barItems.push(vDivider);
    barItems.push(statItem(l, v, color));
  };

  addStat("Fills", String(data.totalFills));
  addStat("Volume", fmtCompact(data.totalVolume));
  const avg = data.totalFills > 0 ? data.realizedPnl / data.totalFills : 0;
  addStat("Avg PnL", fmtUsd(avg), accent);
  if (data.bestTrade) addStat("Best", fmtUsd(data.bestTrade.pnl), C.profit);
  if (data.worstTrade) addStat("Worst", fmtUsd(data.worstTrade.pnl), C.loss);

  const svg = await satori(cardShell(win, leftContent, barItems), {
    width: W,
    height: H,
    fonts: [
      { name: FF, data: getFont(), weight: 400, style: "normal" },
      { name: FF, data: getFont(), weight: 700, style: "normal" },
    ],
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}

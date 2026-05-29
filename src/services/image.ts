import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import satori from "satori";
import sharp from "sharp";
import { moneyShort, signedMoney } from "../bot/lib/fmt.js";

/** Scannable referral badge embedded on share cards. */
export interface ReferralBadge {
  /** Deep link encoded in the QR, e.g. https://t.me/<bot>?start=<code> */
  url: string;
  /** Human-readable code shown under the QR for non-scanners. */
  code: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, "../../assets");

// ── Fonts ─────────────────────────────────────────────────────────────────────

type FontWeight = 400 | 700;
const fontCache = new Map<FontWeight, ArrayBuffer>();

function getFont(weight: FontWeight): ArrayBuffer {
  if (!fontCache.has(weight)) {
    const name = weight === 700 ? "SpaceGrotesk-Bold.ttf" : "SpaceGrotesk-Regular.ttf";
    fontCache.set(weight, readFileSync(join(ASSETS, "fonts", name)).buffer as ArrayBuffer);
  }
  return fontCache.get(weight) as ArrayBuffer;
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

let logoCache: string | null = null;
function getLogo(): string {
  if (logoCache === null) {
    const data = readFileSync(join(ASSETS, "logo.png"));
    logoCache = `data:image/png;base64,${data.toString("base64")}`;
  }
  return logoCache;
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const FF = "SpaceGrotesk";

const C = {
  bg: "#05050f",
  label: "#ffffff",
  text: "#efefef",
  muted: "#FFFFFF",
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
const BAR_H = 96;
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
        fontSize: 16,
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
              fontSize: 16,
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
            style: { fontFamily: FF, fontSize: 24, fontWeight: 700, color: valueColor },
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
  const sideLabel = isLong ? "Long" : "Short";
  const label = leverage !== undefined ? `${sideLabel} ${leverage}x` : sideLabel;
  // Single pill — "Long 10x" / "Short 2x". No glyph (SpaceGrotesk lacks ▲/▼).
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "row" },
      children: [
        {
          type: "div",
          props: {
            style: {
              fontFamily: FF,
              fontSize: 17,
              fontWeight: 700,
              color,
              background: bg,
              border: `1.5px solid ${color}`,
              borderRadius: 8,
              padding: "7px 18px",
            },
            children: label,
          },
        },
      ],
    },
  };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ── Referral badge (QR + code) ──────────────────────────────────────────────

async function referralBadge(ref: ReferralBadge): Promise<Node> {
  const qr = await QRCode.toDataURL(ref.url, {
    margin: 1,
    width: 264,
    color: { dark: "#05050f", light: "#ffffff" },
  });
  // Wrapped in a dark, semi-opaque panel so the white text + QR stay readable
  // over the bright part of the background image.
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        background: "rgba(5,5,15,0.72)",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: 16,
        padding: "13px 14px",
      },
      children: [
        {
          type: "img",
          props: {
            src: qr,
            width: 120,
            height: 120,
            style: { width: 120, height: 120, borderRadius: 8, border: "4px solid #ffffff" },
          },
        },
        {
          type: "div",
          props: {
            style: {
              fontFamily: FF,
              fontSize: 12,
              fontWeight: 700,
              color: C.label,
              letterSpacing: 2,
              textTransform: "uppercase",
            },
            children: "Scan to trade",
          },
        },
        {
          type: "div",
          props: {
            style: { fontFamily: FF, fontSize: 18, fontWeight: 700, color: "#fbbf24" },
            children: ref.code,
          },
        },
      ],
    },
  };
}

// Logo + wordmark, top-left of every card.
const brandRow: Node = {
  type: "div",
  props: {
    style: { display: "flex", flexDirection: "row", alignItems: "center", gap: 12 },
    children: [
      {
        type: "img",
        props: {
          src: getLogo(),
          width: 46,
          height: 46,
          style: { width: 46, height: 46, borderRadius: 11 },
        },
      },
      {
        type: "div",
        props: {
          style: { fontFamily: FF, fontSize: 28, fontWeight: 700, color: C.label },
          children: "SuperNova",
        },
      },
    ],
  },
};

// Fallback top-right chip when no referral badge is supplied.
const creditNode: Node = {
  type: "div",
  props: {
    style: {
      background: "rgba(5,5,15,0.6)",
      borderRadius: 8,
      padding: "6px 12px",
      fontFamily: FF,
      fontSize: 13,
      fontWeight: 700,
      color: C.label,
    },
    children: "SuperNova",
  },
};

// ── Shared card shell ─────────────────────────────────────────────────────────

function cardShell(win: boolean, leftContent: Node[], barItems: Node[], topRight: Node): Node {
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
              // Main row — left panel top-aligned (brand + content), image right
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "row", flex: 1 },
                  children: [
                    // Left panel — top-aligned stack
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          gap: 22,
                          width: PANEL_W,
                          padding: `${PAD_T}px 0 ${PAD_T}px ${PAD_L}px`,
                        },
                        children: [brandRow, ...leftContent],
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
        // Top-right slot — referral QR badge (absolute, doesn't push content down)
        {
          type: "div",
          props: {
            style: { position: "absolute", top: 28, right: 40, display: "flex" },
            children: [topRight],
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
  referral?: ReferralBadge;
}

export async function generatePnlCard(data: PnlCardData): Promise<Buffer> {
  const win = data.pnlUsdc >= 0;
  const accent = win ? C.profit : C.loss;

  const leftContent: Node[] = [
    field("Market", data.symbol, 52),
    directionBadge(data.side, data.leverage),
    field("Realized PnL", signedMoney(data.pnlUsdc), 74, accent),
    txt(fmtPct(data.roiPercent), 44, accent),
  ];

  const topRight = data.referral ? await referralBadge(data.referral) : creditNode;

  const barItems: Node[] = [];
  const addStat = (l: string, v: string, color?: string) => {
    if (barItems.length > 0) barItems.push(vDivider);
    barItems.push(statItem(l, v, color));
  };

  addStat("Entry", `$${data.entryPrice}`);
  addStat("Exit", `$${data.exitPrice}`);
  if (data.size) addStat("Size", data.size);
  if (data.duration) addStat("Duration", data.duration);

  const svg = await satori(cardShell(win, leftContent, barItems, topRight), {
    width: W,
    height: H,
    fonts: [
      { name: FF, data: getFont(400), weight: 400, style: "normal" },
      { name: FF, data: getFont(700), weight: 700, style: "normal" },
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
  referral?: ReferralBadge;
}

export async function generateWalletCard(data: WalletCardData): Promise<Buffer> {
  const win = data.realizedPnl >= 0;
  const accent = win ? C.profit : C.loss;

  const topRight = data.referral ? await referralBadge(data.referral) : creditNode;

  const leftContent: Node[] = [
    field("Trader", shortAddr(data.walletAddress), 32, C.muted),
    field("Total PnL", signedMoney(data.realizedPnl), 80, accent),
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
              children: [lbl("Best Trade"), txt(signedMoney(data.bestTrade.pnl), 32, C.profit)],
            },
          },
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column", gap: 6 },
              children: [lbl("Worst Trade"), txt(signedMoney(data.worstTrade.pnl), 32, C.loss)],
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
  addStat("Volume", moneyShort(data.totalVolume));
  const avg = data.totalFills > 0 ? data.realizedPnl / data.totalFills : 0;
  addStat("Avg PnL", signedMoney(avg), accent);
  if (data.bestTrade) addStat("Best", signedMoney(data.bestTrade.pnl), C.profit);
  if (data.worstTrade) addStat("Worst", signedMoney(data.worstTrade.pnl), C.loss);

  const svg = await satori(cardShell(win, leftContent, barItems, topRight), {
    width: W,
    height: H,
    fonts: [
      { name: FF, data: getFont(400), weight: 400, style: "normal" },
      { name: FF, data: getFont(700), weight: 700, style: "normal" },
    ],
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}

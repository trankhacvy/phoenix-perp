export function num(n: number | string, minDec = 0, maxDec = 2): string {
  const v = Number(n);
  if (Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: minDec,
    maximumFractionDigits: maxDec,
  });
}

export function usd(n: number | string, minDec = 2, maxDec = 2): string {
  const v = Number(n);
  if (Number.isNaN(v)) return "$—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: minDec,
    maximumFractionDigits: maxDec,
  });
}

export function price(n: number | string): string {
  const v = Number(n);
  if (Number.isNaN(v) || v === 0) return "$—";
  if (v >= 1000) return usd(v);
  if (v >= 1) return `$${num(v, 2, 2)}`;
  if (v >= 0.01) return `$${num(v, 4, 4)}`;
  return `$${num(v, 6, 6)}`;
}

export function pct(n: number | string, decimals = 2): string {
  const v = Number(n);
  if (Number.isNaN(v)) return "—%";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${num(v, decimals, decimals)}%`;
}

export function funding1h(rateDecimal: number): string {
  const pct = rateDecimal * 100;
  return `${pct >= 0 ? "+" : ""}${num(pct, 4, 4)}%`;
}

export function pnlEmoji(n: number): string {
  return n >= 0 ? "🟢" : "🔴";
}

export function signedUsd(n: number): string {
  return n >= 0 ? `+${usd(n)}` : usd(n);
}

export function fundingDir(rateDecimal: number): string {
  return rateDecimal >= 0 ? "Longs pay shorts" : "Shorts pay longs";
}

export function cryptoSize(n: number | string, symbol: string, minDec = 2, maxDec = 6): string {
  const v = Number(n);
  if (Number.isNaN(v)) return `— ${symbol}`;
  return `${num(v, minDec, maxDec)} ${symbol}`;
}

export function shortAddr(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

export function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  return Number.parseFloat(cleaned);
}

export function parseLeverage(raw: string): number {
  return Number.parseFloat(raw.replace(/[xX]/g, ""));
}

export function solscanUrl(sig: string, cluster?: "devnet" | "testnet"): string {
  const base = `https://solscan.io/tx/${sig}`;
  return cluster ? `${base}?cluster=${cluster}` : base;
}

export function timeAgo(ts: number): string {
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  const s = (Date.now() - tsMs) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const _usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});
const _numCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const _numCompactSigned = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

export function compactUsd(n: number): string {
  return Number.isFinite(n) ? _usdCompact.format(n) : "$—";
}

export function compact(n: number): string {
  return Number.isFinite(n) ? _numCompact.format(n) : "—";
}

export function compactSigned(n: number): string {
  return Number.isFinite(n) ? _numCompactSigned.format(n) : "—";
}

export function fundingDailyUsd(rateDecimal: number, notionalUsdc: number): string {
  const dailyUsd = Math.abs(rateDecimal) * notionalUsdc * 24;
  return `$${num(dailyUsd, 2, 2)}/day`;
}

export function liqDistanceLabel(
  side: "long" | "short",
  markPrice: number,
  liqPrice: number,
): string {
  const dist =
    side === "long"
      ? ((markPrice - liqPrice) / markPrice) * 100
      : ((liqPrice - markPrice) / markPrice) * 100;
  const dir = side === "long" ? "falls" : "rises";
  return `${dir} ${num(dist, 0, 1)}% to ~${price(liqPrice)}`;
}

export function fundingDot(rateDecimal: number): string {
  const pct1h = Math.abs(rateDecimal * 100);
  if (pct1h < 0.0005) return "⚪";
  return rateDecimal >= 0 ? "🟢" : "🔴";
}

export function fundingTrend(rates: number[]): string {
  if (rates.length < 3) return "";
  const recent = rates.slice(-3);
  const deltas = recent.slice(1).map((r, i) => r - recent[i]);
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  if (avgDelta > 0.00001) return "↑↑";
  if (avgDelta > 0) return "↑";
  if (avgDelta < -0.00001) return "↓↓";
  if (avgDelta < 0) return "↓";
  return "→";
}

// Live marketStats funding values are already percentages — append %, no scaling.
export function fundingAnnual(pctPerYear: number): string {
  const sign = pctPerYear >= 0 ? "+" : "";
  return `${sign}${num(pctPerYear, 1, 2)}%/yr`;
}

export function fundingHourly(pctPerHour: number): string {
  const sign = pctPerHour >= 0 ? "+" : "";
  return `${sign}${num(pctPerHour, 4, 4)}%/h`;
}

export function change24h(pctValue: number): string {
  const arrow = pctValue >= 0 ? "▲" : "▼";
  return `${arrow} ${num(Math.abs(pctValue), 2, 2)}%`;
}

export function fundingDotAnnual(annualPct: number): string {
  if (Math.abs(annualPct) < 1) return "⚪";
  return annualPct >= 0 ? "🟢" : "🔴";
}

// ─── Semantic number API (Intl-backed; never .toFixed) ───────────────────────
// Money: exact for transacted amounts, compact for aggregates.
export function money(n: number): string {
  return usd(n);
}

export function signedMoney(n: number): string {
  return signedUsd(n);
}

export const moneyShort = compactUsd;

// Percent: values are already in percent units (12.5 means 12.5%).
const _pctCache = new Map<string, Intl.NumberFormat>();
function pctFmt(dp: number, signed: boolean): Intl.NumberFormat {
  const key = `${dp}:${signed}`;
  let f = _pctCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
      ...(signed ? { signDisplay: "exceptZero" as const } : {}),
    });
    _pctCache.set(key, f);
  }
  return f;
}

export function percent(n: number, dp = 2): string {
  return Number.isFinite(n) ? `${pctFmt(dp, true).format(n)}%` : "—%";
}

export function percentAbs(n: number, dp = 2): string {
  return Number.isFinite(n) ? `${pctFmt(dp, false).format(n)}%` : "—%";
}

const _tokCache = new Map<number, Intl.NumberFormat>();
function tokFmt(dp: number): Intl.NumberFormat {
  let f = _tokCache.get(dp);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { maximumFractionDigits: dp });
    _tokCache.set(dp, f);
  }
  return f;
}

export function tokenSize(n: number, baseLotsDecimals: number, symbol?: string): string {
  if (!Number.isFinite(n)) return symbol ? `— ${symbol}` : "—";
  const s = tokFmt(Math.min(4, baseLotsDecimals)).format(n);
  return symbol ? `${s} ${symbol}` : s;
}

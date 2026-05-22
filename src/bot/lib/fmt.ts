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
  if (Number.isNaN(v)) return "$—";
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

export function fundingApr(rateDecimal: number): string {
  const apr = rateDecimal * 1095 * 100;
  return `${apr >= 0 ? "+" : ""}${num(apr, 2, 2)}% / yr`;
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

export function solscanUrl(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
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

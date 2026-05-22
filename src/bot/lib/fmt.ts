export function usd(n: number | string): string {
  const v = Number(n);
  if (isNaN(v)) return "$—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function price(n: number | string): string {
  const v = Number(n);
  if (isNaN(v)) return "$—";
  if (v >= 1000) return usd(v);
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

export function pct(n: number | string, decimals = 2): string {
  const v = Number(n);
  if (isNaN(v)) return "—%";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(decimals)}%`;
}

export function fundingApr(rateDecimal: number): string {
  const apr = rateDecimal * 1095 * 100;
  return `${apr >= 0 ? "+" : ""}${apr.toFixed(2)}% / yr`;
}

export function fundingDir(rateDecimal: number): string {
  return rateDecimal >= 0 ? "Longs pay shorts" : "Shorts pay longs";
}

export function cryptoSize(n: number | string, symbol: string): string {
  const v = Number(n);
  if (isNaN(v)) return `— ${symbol}`;
  return `${v.toFixed(4)} ${symbol}`;
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
  return Math.round(Number.parseFloat(raw.replace(/[xX]/g, "")));
}

export function solscanUrl(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

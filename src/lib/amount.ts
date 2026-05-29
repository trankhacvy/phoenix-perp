export function toNative(decimal: string, decimals: number): bigint {
  const s = decimal.trim();
  if (s === "" || s === "." || !/^\d*(\.\d*)?$/.test(s)) {
    throw new Error(`toNative: invalid decimal "${decimal}"`);
  }
  const [intPart = "0", fracRaw = ""] = s.split(".");
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  const digits = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits === "" ? "0" : digits);
}

export function fromNative(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const padded = abs.toString().padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  const intPart = padded.slice(0, cut);
  const frac = padded.slice(cut).replace(/0+$/, "");
  return `${neg ? "-" : ""}${intPart}${frac ? `.${frac}` : ""}`;
}

export function tokensToLots(tokenStr: string, baseLotsDecimals: number): bigint {
  return toNative(tokenStr, baseLotsDecimals);
}

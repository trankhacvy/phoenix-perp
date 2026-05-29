import { ATR, BollingerBands, MACD, RSI } from "technicalindicators";
import { getPhoenixClient } from "./client.js";
import { acquirePhoenixRest } from "./rest-limit.js";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getCandles(symbol: string, timeframe = "1h", limit = 60): Promise<Candle[]> {
  await acquirePhoenixRest();
  const raw = await getPhoenixClient()
    .api.candles()
    .getCandles(symbol.toUpperCase(), { timeframe, limit })
    .catch(() => null);
  if (!raw) return [];
  return raw.map((c) => ({
    timestamp: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

export interface TaSnapshot {
  rsi: number | null;
  macdHist: number | null;
  bbUpperBand: number | null;
  bbLowerBand: number | null;
  atr: number | null;
}

export async function getTaSnapshot(symbol: string): Promise<TaSnapshot> {
  const candles = await getCandles(symbol, "1h", 60);
  if (candles.length < 20) {
    return { rsi: null, macdHist: null, bbUpperBand: null, bbLowerBand: null, atr: null };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues.at(-1) ?? null;

  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdHist = macdValues.at(-1)?.histogram ?? null;

  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bb = bbValues.at(-1);
  const bbUpperBand = bb?.upper ?? null;
  const bbLowerBand = bb?.lower ?? null;

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues.at(-1) ?? null;

  return { rsi, macdHist, bbUpperBand, bbLowerBand, atr };
}

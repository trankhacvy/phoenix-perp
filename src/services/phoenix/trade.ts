// Placeholder service — wired up once Rise SDK package name is confirmed
// All orders must be wrapped through Flight (see client.ts getFlightConfig)

export interface MarketOrderParams {
  symbol: string;
  side: "long" | "short";
  sizeUsdc: number;
  slippageBps?: number;
  walletAddress: string;
}

export interface LimitOrderParams extends MarketOrderParams {
  price: number;
}

export interface TpSlParams {
  symbol: string;
  walletAddress: string;
  tpPrice?: number;
  slPrice?: number;
  // SL in Market mode submits IOC with 10% slippage buffer around trigger price
  slMode?: "market" | "limit";
  tpMode?: "market" | "limit";
}

export async function placeMarketOrder(_params: MarketOrderParams): Promise<string> {
  // Returns transaction signature
  throw new Error("Rise SDK not configured");
}

export async function placeLimitOrder(_params: LimitOrderParams): Promise<string> {
  throw new Error("Rise SDK not configured");
}

export async function setTpSl(_params: TpSlParams): Promise<void> {
  throw new Error("Rise SDK not configured");
}

export async function closePosition(
  _symbol: string,
  _walletAddress: string,
  _fraction = 1,
): Promise<string> {
  throw new Error("Rise SDK not configured");
}

export async function addMargin(
  _symbol: string,
  _walletAddress: string,
  _amountUsdc: number,
): Promise<string> {
  throw new Error("Rise SDK not configured");
}

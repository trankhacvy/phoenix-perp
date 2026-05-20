import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { config } from "../../config/index.js";

export function getFlightConfig() {
  return {
    builderAuthority: config.BUILDER_AUTHORITY_PUBKEY,
    builderPdaIndex: 0,
    builderSubaccountIndex: 0,
  };
}

export interface PhoenixClient {
  ixs: {
    placeMarketOrder(params: {
      marketSymbol: string;
      side: "bid" | "ask";
      sizeInQuote?: number;
      sizeInBase?: number;
      slippageBps?: number;
      reduceOnly?: boolean;
    }): Promise<unknown>;
    placeLimitOrder(params: {
      marketSymbol: string;
      side: "bid" | "ask";
      sizeInQuote: number;
      price: number;
    }): Promise<unknown>;
    buildPlaceStopLoss(params: {
      marketSymbol: string;
      triggerPriceInTicks: number;
      orderType: "market" | "limit";
    }): Promise<unknown>;
    depositCollateral(params: { amountUsdc: number }): Promise<unknown>;
    withdrawCollateral(params: {
      amountUsdc: number;
      destinationAddress: string;
    }): Promise<unknown>;
  };
  sendAndConfirm(ix: unknown): Promise<string>;
  exchange(): {
    getMarket(symbol: string): Promise<{ tickSize: number }>;
  };
  traders(): {
    getTraderStateSnapshot(params: { walletAddress: string }): Promise<{
      positions: Array<{ symbol: string; side: "long" | "short"; size: string }>;
    }>;
  };
}

type WalletSigner = (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;

export async function createTradingClient(_signer: WalletSigner): Promise<PhoenixClient> {
  throw new Error(
    "Rise SDK not configured — confirm npm package name with Phoenix/Ellipsis Labs team",
  );
}

export async function getHttpClient(): Promise<never> {
  throw new Error(
    "Rise SDK not configured — confirm npm package name with Phoenix/Ellipsis Labs team",
  );
}

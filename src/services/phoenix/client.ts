import {
  createPhoenixClient,
  type Authority,
  type PhoenixClient,
} from "@ellipsis-labs/rise";
import { config } from "../../config/index.js";

export type PhoenixRiseClient = PhoenixClient; //ReturnType<typeof createPhoenixClient>;

const BASE_CLIENT_OPTIONS = {
  apiUrl: config.PHOENIX_API_URL,
  rpcUrl: config.HELIUS_RPC_URL,
  exchangeMetadata: { stream: false },
} as const;

let _readClient: PhoenixRiseClient | null = null;

export function getPhoenixClient(): PhoenixRiseClient {
  if (!_readClient) {
    _readClient = createPhoenixClient(BASE_CLIENT_OPTIONS);
  }
  return _readClient;
}

let _tradingClient: PhoenixRiseClient | null = null;

// A real base58 Solana pubkey is 43-44 chars. The stub "11111...1" (32 chars) means
// no builder authority is configured, so skip flight routing to avoid proxy panic.
const BUILDER_PUBKEY_VALID = config.BUILDER_AUTHORITY_PUBKEY.length >= 43;

export function getTradingClient(): PhoenixRiseClient {
  if (!_tradingClient) {
    _tradingClient = createPhoenixClient({
      ...BASE_CLIENT_OPTIONS,
      ...(BUILDER_PUBKEY_VALID
        ? {
            flight: {
              builderAuthority: config.BUILDER_AUTHORITY_PUBKEY as Authority,
            },
          }
        : {}),
    });
  }
  return _tradingClient;
}


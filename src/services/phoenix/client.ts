import {
  type Authority,
  type PhoenixClient,
  type PhoenixWsClient,
  createPhoenixClient,
  createPhoenixWsClient,
} from "@ellipsis-labs/rise";
import { WebSocket as NodeWebSocket } from "ws";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";

// The Rise WS client relies on a global `WebSocket`, which Node does not always
// expose. Provide the `ws` implementation before the SDK opens a connection.
function ensureWebSocketGlobal(): void {
  if (typeof globalThis.WebSocket === "undefined") {
    Object.assign(globalThis, { WebSocket: NodeWebSocket });
  }
}

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

let _wsClient: PhoenixWsClient | null = null;

export function getPhoenixWsClient(): PhoenixWsClient {
  if (!_wsClient) {
    ensureWebSocketGlobal();
    _wsClient = createPhoenixWsClient({
      url: config.PHOENIX_WS_URL,
      backoff: { baseMs: 1000, maxMs: 30_000 },
      onServerError: (message) => logger.error({ message }, "Phoenix WS server error"),
    });
  }
  return _wsClient;
}

export function closePhoenixWsClient(): void {
  _wsClient?.close();
  _wsClient = null;
}

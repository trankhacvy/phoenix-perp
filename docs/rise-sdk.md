# Rise SDK

Developer-facing SDK for Phoenix perpetuals, available in TypeScript and Rust

Rise is the developer-facing SDK surface for Phoenix perpetuals. It currently ships as:

- `rise/ts` — the TypeScript SDK, with HTTP route clients, a unified exchange-aware client, instruction builders, Flight helpers, and WebSocket adapters
- `rise/rust` — the Rust workspace, centered on the `phoenix-rise` crate, with typed HTTP/WS clients, transaction builders, math helpers, and low-level instruction builders

## Where to start

- Reach for `PhoenixHttpClient` / `client.api` when you need public HTTP data or invite activation.
- Reach for `createPhoenixClient(...)` when you want exchange metadata, PDA derivation, order-packet helpers, and `client.ixs`.
- Reach for `client.streams` or `createPhoenixWsClient(...)` when you want typed live adapters.
- Reach for `PhoenixTxBuilder` in Rust when you want to construct and sign your own Solana instructions.

## Runnable entry points

TypeScript:
- [`ts/examples/01-http-client.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/01-http-client.ts)
- [`ts/examples/02-ws-fills.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/02-ws-fills.ts)
- [`ts/examples/03-build-limit-order-ix.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/03-build-limit-order-ix.ts)
- [`ts/examples/04-trader-state-store.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/04-trader-state-store.ts)
- [`ts/examples/05-cancel-all-conditional-orders.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/05-cancel-all-conditional-orders.ts)
- [`ts/examples/phoenix-client-example.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/phoenix-client-example.ts)
- [`ts/examples/phoenix-ws-example.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/phoenix-ws-example.ts)
- [`ts/README.md`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/README.md)
- [`ts/examples/README.md`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/README.md)

Rust:
- [`rust/README.md`](https://github.com/Ellipsis-Labs/rise-public/blob/master/rust/README.md)
- [`rust/sdk/examples/register_trader.rs`](https://github.com/Ellipsis-Labs/rise-public/blob/master/rust/sdk/examples/register_trader.rs)
- [`rust/sdk/examples/http_client.rs`](https://github.com/Ellipsis-Labs/rise-public/blob/master/rust/sdk/examples/http_client.rs)
- [`rust/sdk/examples/send_limit_order.rs`](https://github.com/Ellipsis-Labs/rise-public/blob/master/rust/sdk/examples/send_limit_order.rs)
- [`rust/sdk/examples/send_market_order.rs`](https://github.com/Ellipsis-Labs/rise-public/blob/master/rust/sdk/examples/send_market_order.rs)

## Onboarding: access code vs referral code

These invite routes are not interchangeable:

- Use `POST /v1/invite/activate` when you have an access code / allowlist code. Send that value as `code`.
- Use `POST /v1/invite/activate-with-referral` when you have a referral code. Send that value as `referral_code`.

## Fetching exchange, market, and trader state

The HTTP surface is intentionally split by what kind of state you want:

- `exchange().getSnapshot()` — exchange-wide state plus every market's current config snapshot
- `exchange().getMarket(symbol)` — one market's fees, risk, funding cadence, and configuration
- `orderbook().getOrderbook(symbol)` — an HTTP L2 snapshot for one market
- `traders().getTraderStateSnapshot(...)` (TypeScript) or `traders().get_trader(...)` (Rust) — a trader-centric view of collateral, positions, orders, and triggers
- `markets().getMarketStatsHistory(...)` and `funding().getFundingRateHistory(...)` — time-series data for frontends, vault products, and analytics

## Order placement and cancellation

The SDK separates packet construction from instruction construction:

- Build packet sizes and prices with `client.orderPackets`
- Build or wrap the actual Solana instructions with `client.ixs`
- Use the lower-level builders when you need conditional-account setup or other specialized flows

`buildPlaceStopLoss(...)` takes tick-based trigger prices. When starting from USD prices, convert them from market metadata first.

## Flight builder activation and routed orders

Flight support in Rise is currently beta and should not yet be treated as a stable production surface.

Flight is the builder-routing layer. Key pieces:

- The builder still needs a Phoenix trader account
- Builder registration is its own on-chain instruction (see [Flight](/phoenix/flight#registering))
- The builder's associated trader account is the fee collector for Flight-routed orders
- Once a client is configured with `flight: { builderAuthority, ... }`, supported order instructions are wrapped automatically

When you register Flight against a builder authority and its associated trader account, all builder fees from Flight-routed orders accrue to that builder trader account. Those fees are withdrawable from the Phoenix frontend.

## Live market data

Use the typed WebSocket adapters when you want continuous updates instead of a single HTTP snapshot.

Ready-to-run TypeScript stream examples:

- [`ts/examples/02-ws-fills.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/02-ws-fills.ts)
- [`ts/examples/phoenix-ws-example.ts`](https://github.com/Ellipsis-Labs/rise-public/blob/master/ts/examples/phoenix-ws-example.ts)

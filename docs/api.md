# API

Phoenix REST and WebSocket API endpoints for market data, trader state, registration, and transaction building.

## API Overview

Phoenix exposes a public REST API for snapshots and request/response workflows, plus a WebSocket API for live subscriptions.

| Surface | URL |
| --- | --- |
| REST API | `https://perp-api.phoenix.trade` |
| WebSocket | `wss://perp-api.phoenix.trade/v1/ws` |

Use REST when you need a point-in-time response, such as exchange configuration, market metadata, trader state, historical fills, registration, or transaction-builder responses. Use WebSocket subscriptions when you need continuous updates, such as orderbooks, trades, candles, trader state, or exchange parameter changes.

## REST API

The REST API accepts and returns JSON. Requests with bodies should send `Content-Type: application/json`.

The public reference is organized into:

- `Auth` — wallet, service, and session authentication.
- `Exchange` — exchange, market, and candle queries.
- `Registration` — invite and referral activation.
- `Trader` — trader state, account history, and transaction builders.

Some numeric values are string-encoded in responses so clients can preserve full integer precision. Use the schema in the REST API reference for exact field types.

### Authentication and Errors

Most exchange, market, and trader read endpoints are public. Routes that require a session use bearer tokens returned by the authentication endpoints.

Error responses use a JSON object with an `error` string:

```json
{
  "error": "error_code_or_message"
}
```

## WebSocket API

The WebSocket API uses JSON client messages:

```json
{
  "type": "subscribe",
  "subscription": {
    "channel": "orderbook",
    "symbol": "SOL"
  }
}
```

The WebSocket protocol page documents supported channels, request envelopes, confirmation/error messages, and response payloads.

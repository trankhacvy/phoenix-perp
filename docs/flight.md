# Flight

## Overview
Builder codes for Phoenix — earn a share of fees on the order flow you route.

Flight is Phoenix's builder-code layer. If you run a trading app, terminal, bot, or agent that sends orders to Phoenix, you can register as a builder, route orders through Flight, and collect a fee on the volume you bring.

## How it works
1. Register a builder at flight dashboard. Registration is an on-chain instruction that ties your wallet (the builder authority) to a Phoenix trader account where Flight fees accrue.
2. Set your builder fee in basis points at registration. The fee is added on top of Phoenix's base exchange fees and is paid by the trader on each routed order.
3. Route orders through Flight from your client. Once the SDK client is configured with your builder authority, supported order instructions are wrapped automatically.
4. Collect fees as collateral on your builder trader account. Withdraw any time from the Flight portal.

## Fees
Flight currently collects builder fees on liquidity-removing fills:
- Market orders
- The taking portion of a limit order that crosses the book

If a routed limit order rests as maker liquidity, the resting portion does not generate a Flight fee today. Maker-side fee collection is on the roadmap so builders can also earn on routed liquidity that rests first and fills later.

The builder fee is separate from — and stacks on top of — Phoenix's base taker and maker fees. Builders set their own bps at registration.

## Registering
Register using the flight dashboard. The portal is also where you track accrued fees and withdraw funds.

We recommend registering with a fresh, empty wallet. Builder fees accrue as collateral on the Phoenix trader account tied to your builder authority, so a clean wallet keeps builder revenue isolated from any existing trading collateral.

## Using Flight
We recommend creating a dedicated embedded wallet for each user who interacts with Phoenix. This keeps their Phoenix activity isolated from other platforms that integrate with Phoenix.

## Onboarding users to Phoenix
Phoenix is currently in private beta, so users need an access code or referral code to use the platform. As a builder, you can complete this flow on behalf of your users. Contact us for more details.

## SDK integration
Rise, the Phoenix SDK, supports Flight-routed order instructions in TypeScript and Rust. See the SDK doc for setup and examples.

Flight support in Rise is currently in beta.

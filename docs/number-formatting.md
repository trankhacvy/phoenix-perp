# Numbers: calculation & display standard

> Status: proposal (no code changed yet). One source of truth for **how numbers are
> computed** (precision/bigint) and **how they're rendered** (formatting), so money is never
> corrupted by a float and the same value never shows two ways.

Two parts:
- **Part 1 — Calculation & precision** (the part that protects funds).
- **Part 2 — Display formatting** (the part the user sees).

---

# Part 1 — Calculation & precision

## 1.1 Current state (honest audit)

The codebase **mostly already does the right thing**: on-chain quantities (base lots, ticks,
quote lots) are handled as `bigint`, and `number` is used only at display. Good patterns
already in use:

- `(positionLots * BigInt(scaled)) / 10_000n` — percent-of-position in pure bigint
  (`conditional.ts`).
- `Number((lots * 10000n) / positionLots) / 100` — compute in bigint, convert to float
  **only at the very end** for display (`tpsl.ts`, `positions.ts`).

The weak spots, ranked by how close they are to real funds:

1. **Float → bigint at the transaction boundary.** User decimal → `number` → round → `bigint`:
   - `deposit.ts:92`, `withdraw.ts:576,667`: `BigInt(Math.round(amount * 1_000_000))`
   - `positions.ts:370`: `BigInt(Math.round(Number(pos.size) * 10 ** baseLotsDecimals))`
   - `conditional.ts:116/157`: `BigInt(Math.floor(num * mult))`, `BigInt(Math.floor(size.tokens * factor))`

   Works for ≤2dp USDC **today**, but it's unprincipled: `amount` is a parsed float, so the
   path is float-multiply → round → bigint. Breaks for large or many-dp inputs and is exactly
   the class of bug that silently sends the wrong amount.

2. **`fractionToCloseLots(rawLots: number, fraction)`** (`lots.ts`) takes a **`number`** and does
   `Math.ceil(absLots * fraction)`. Callers already hold `bigint` position lots and narrow them
   to `number` first → precision loss above 2^53, plus float `fraction` math. The close size is
   submitted on-chain → this is fund-adjacent.

3. **`marginToTokens`** (`lots.ts`) computes `(margin * leverage) / price` in float, returns a
   `toFixed` **string**, which is later re-parsed to lots via float again → the size→lots path
   crosses float **twice**.

## 1.2 The principle (headline rule)

> **Any number that becomes part of a transaction — an amount, a size, a price-as-ticks —
> must never pass through a JS `number`/float.** Parse the human decimal *string* straight to
> native integer (`bigint`), do the arithmetic in `bigint`, and convert to `number` only for
> display or for explicitly-approximate estimates.

## 1.3 Three-layer model

| Layer | Domain | Type | Rule |
|---|---|---|---|
| **L1 — On-chain integer** | native USDC (×1e6), base lots, ticks, quote lots | `bigint` | exact; all tx-bound math stays here |
| **L2 — Derived / analytics** | PnL, notional, ROI, ratios, liq price, fee estimate | `number` | *explicitly approximate* — inputs (mark price) are already floats |
| **L3 — Display** | strings the user reads | `string` | Part 2 formatters |

**L1 chokepoints** (the only sanctioned float↔native crossings):

```ts
// Parse a decimal STRING (never a float) into native integer units.
// toNative("123.456789", 6) -> 123456789n ;  toNative("1.5", 6) -> 1500000n
toNative(decimalStr: string, decimals: number): bigint

// Exact native -> decimal string for display.
// fromNative(123456789n, 6) -> "123.456789"
fromNative(value: bigint, decimals: number): string
```

`toNative` splits on `.`, pads/truncates the fractional part to `decimals`, and assembles a
`bigint` from the digit string — **no `* 10**n` float multiply**. Everything downstream
(amount, size, percent-of-position) stays `bigint`: `lots * BigInt(bps) / 10_000n`, ceil/floor
done with bigint remainder checks.

**L2 stays `number` on purpose.** Mark price arrives from the WS as a float; running PnL or
notional through a decimal library is *false precision* and just adds weight. Centralize these
formulas (one `metrics.ts`) and label their outputs as estimates.

## 1.4 Library decision (honest)

- **Default: native `bigint` + string parsing. No new dependency.** It's exact, matches the
  Rise SDK (which already returns `bigint`/strings), and a ~40-line `toNative`/`fromNative`
  covers the entire integer domain.
- **Reject `decimal.js` / `bignumber.js`** for the money path. They're arbitrary-precision
  *decimal* (string-backed) libraries that (a) invite use in the L2 estimate layer where the
  precision is fake, (b) add bundle weight, and (c) don't match Solana's native-integer reality.
- **Optional upgrade: [`dnum`](https://github.com/bpierre/dnum)** — tiny, `bigint`-backed
  `[value, decimals]` tuples designed exactly for token amounts (mul/div/format across
  decimals). Adopt **only if** the L1 helpers start doing cross-decimal multiplication
  (e.g. native price × native size). Until then `toNative`/`fromNative` suffice.

## 1.5 The fixes

1. `BigInt(Math.round(amount * 1_000_000))` → `toNative(amountStr, 6)`. **Carry the raw input
   string** from the pending-input handler instead of the parsed float.
2. `fractionToCloseLots(rawLots: bigint, pctBps: number): bigint` → all `bigint`:
   `absLots * BigInt(pctBps) / 10_000n` with a bigint ceil (add `1n` when remainder ≠ 0).
   Callers pass the `bigint` position lots they already have — stop narrowing to `number`.
3. `marginToTokens` → either compute lots in the integer domain, or keep the float sizing but
   **round to lots exactly once** with `floor`, and document it as an L2 estimate (size is a
   user-facing target, the on-chain packet re-derives lots). Pick one and make it explicit.
4. Keep the good bigint-percent pattern; **ban `Number(bigLots) * fraction`**.

## 1.6 Guardrails
- CI grep flags the float→bigint smell in `src/`: `Math.round(.*\* 1_000_000)`,
  `Math.round(Number(.*10 \*\*`, and `BigInt(Math\.`.
- Unit tests: `toNative`/`fromNative` round-trips (trailing zeros, values > 2^53, max
  decimals, no fractional part); `fractionToCloseLots` with huge `bigint` lot counts.

## 1.7 Decisions to confirm
1. `bigint` + helpers (no lib) now, `dnum` only if cross-decimal mul appears? (rec: yes)
2. Scope the sweep to **fund-moving paths first** (deposit/withdraw/close/order size), defer
   pure display-size conversions? (rec: yes)
3. Add the float→bigint CI grep? (rec: yes)

---

# Part 2 — Display formatting

## 2.1 The problem (concrete)

The same *kind* of number renders differently depending on which file drew it:

- A USD amount renders as `$1,232,222.20` via `usd()` but `$1.2M` via `compactUsd()`/`compact()`.
- **Four** separate compact-money implementations, each with different thresholds/decimals:

| Where | Kicks in (K) | M decimals | Sign? | `$`? |
|---|---|---|---|---|
| `fmt.ts` `compactUsd` | **100K** (under = full `$50,000`) | 1 | `-` only | yes |
| `fmt.ts` `compact` | 1K / 10K | 1 | `-` only | no |
| `guardian.ts` `formatCompact` | 1K | 1 | **none** (breaks on negatives) | no |
| `image.ts` `fmtUsd` / `fmtCompact` | 1K | 2 / 1 | `+/-` | yes |

  So `$50,000` shows as `$50,000` (leaderboard old path), `50K` (guardian), or `$50,000.00`
  (PnL card) depending on screen.

- **109 raw `.toFixed()`** display calls across `src/bot/commands/*` — inline-reinvented
  `signedUsd` (`${n>=0?"+":""}$${n.toFixed(2)}`), ad-hoc `$${x.toFixed(2)}`, token size
  copy-pasted as `tokens.toFixed(Math.min(4, baseLotsDecimals))` (~6 sites), percents at
  0/1/2/3/4 dp.

**Root cause:** no *semantic* formatter layer mapping meaning → format; callers reach for
raw `.toFixed()` whenever a helper doesn't exactly fit.

## 2.2 The honest insight

"Standardize" ≠ "compact everywhere." Different contexts need different precision:

- **Money you act on** (balances, collateral, deposit/withdraw, order cost, fees) → **exact**
  `$1,232,222.20`. Compacting a transacted amount is confusing and risky.
- **Glanceable aggregates** (volume, OI, leaderboard) → **compact** `$1.2M`.
- **Asset prices** → tiered decimals (`price()`). Never compact.
- **Token sizes** → precision from the market's `baseLotsDecimals`.
- **Percentages** → fixed decimals *by context* (funding 4dp, ROI 2dp, coverage 0dp).
- **PnL** → signed; exact in detail screens, compact in dense lists.

So the standard is a small set of **named semantic formatters** + a **locked policy**.

## 2.3 Proposed API (in `src/bot/lib/fmt.ts`)

```ts
money(n)            // 1232222.2 -> "$1,232,222.20"   (exact; transacted amounts)
signedMoney(n)      // -42.5 -> "-$42.50", 18 -> "+$18.00"
moneyShort(n)       // 1232222 -> "$1.2M", 50000 -> "$50K", 940 -> "$940"  (aggregates only)
signedMoneyShort(n) // 138 -> "+$138", -1232222 -> "-$1.2M"
price(n)            // tiered decimals by magnitude (unchanged)
tokenSize(n, dec, symbol?) // 1.23456, 4 -> "1.2346" / "1.2346 SOL"
percent(n, dp?)     // 12.5 -> "+12.50%"
percentAbs(n, dp?)  // sign implied by context ("X% away/covered")
compactNum(n)       // 1234 -> "1.2K"  (counts, base-unit volume; no currency)
```

Keep: `pnlEmoji`, `shortAddr`, `solscanUrl`, `timeAgo`, parsing helpers, funding family.

## 2.4 Locked policy
- **Compact tiers** (single definition for `moneyShort`/`compactNum`): `>=1e9 B`, `>=1e6 M`
  (1dp), `>=1e3 K` (1dp, trailing `.0` trimmed), else integer (or 2dp sub-$1). **Compact always
  starts at 1,000** — kill `compactUsd`'s 100K cliff.
- **Exact money** = `Intl en-US` currency, 2dp, commas. Never compacts.
- **Sign** = always via `signed*`. No inline `n>=0?"+":""`.
- **Negatives in compact** = sign outside symbol `-$1.2M` (fixes guardian's break).

## 2.5 Meaning → formatter
| Value | Formatter |
|---|---|
| Balance, deposit/withdraw, order cost, fee ($) | `money` |
| PnL (detail screens) | `signedMoney` |
| PnL / volume / OI (dense lists, leaderboard) | `signedMoneyShort` / `moneyShort` |
| Daily funding cost | `money` + `/day` |
| Entry/mark/liq/trigger price | `price` |
| Position / rung size (tokens) | `tokenSize` |
| Leverage (`2.5×`) | `num(n,0,2)+"×"` |
| ROI %, liq distance %, coverage % | `percent` / `percentAbs` (explicit dp) |
| Funding hourly/annual % | existing `fundingHourly` / `fundingAnnual` |
| Referral rebate (USDC, 6dp) | exact 6dp helper |

## 2.6 Migration (incremental, behind aliases)
1. Add semantic layer to `fmt.ts`; one shared `compactTier()`. Alias `usd→money`,
   `compactUsd→moneyShort`, `compact→compactNum`, `compactSigned→signedMoneyShort` so nothing
   breaks day one.
2. Delete duplicates: `guardian.ts formatCompact`, `image.ts fmtUsd`/`fmtCompact` → import
   from `fmt.ts` (card may keep exact `signedMoney` deliberately).
3. Sweep the 109 raw `.toFixed()` by category (signed-PnL → `signedMoney`, `$..toFixed(2)` →
   `money`, token size → `tokenSize`, percents → `percent(x, dp)` preserving intentional dp).
4. Lock with a test table in `tests/unit/lib/fmt.test.ts` (negatives, zero, sub-$1, boundaries
   999/1000/999_999/1_000_000).
5. CI grep banning new `.toFixed(`/`$${` in `src/bot/commands/**`.

## 2.7 Honest tradeoffs
- Sweeping 109 sites risks subtle visual diffs → migrate file-by-file behind aliases.
- **Don't** over-unify percentages — funding (4dp) vs ROI (2dp) differ on purpose; `percent`
  takes `dp`.
- Money compaction is **opt-in by context**; balances stay exact.
- Telegram's proportional font means this standardizes *precision & style*, not column
  alignment (impossible alongside tappable links).

## 2.8 Decisions to confirm
1. Compact threshold = 1,000 everywhere (kill 100K cliff)? (rec: yes)
2. Migrate gradually behind aliases? (rec: yes)
3. Referral USDC stays 6dp exact? (rec: yes)
4. Add CI grep banning raw `.toFixed` in commands? (rec: yes)

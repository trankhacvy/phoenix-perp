#!/usr/bin/env bash
# Guardrail for docs/number-formatting.md. Fails CI on:
#   1. float -> bigint conversions for on-chain amounts (use toNative from src/lib/amount.ts)
#   2. raw .toFixed() in the command layer (use the Intl formatters in src/bot/lib/fmt.ts)
# Sanctioned exceptions carry a `// numfmt-ignore` marker.
set -uo pipefail

fail=0

floatToBigint=$(grep -rnE 'BigInt\(Math\.|Math\.(round|floor)\([^)]*\* ?1(_?000_?000|e6|e9)' src --include='*.ts' \
  | grep -v 'src/lib/amount.ts' \
  | grep -v 'numfmt-ignore' || true)
if [ -n "$floatToBigint" ]; then
  echo "✖ float→bigint conversion(s) found — parse decimal strings via toNative() instead:"
  echo "$floatToBigint"
  fail=1
fi

toFixed=$(grep -rnE '\.toFixed\(' src/bot/commands --include='*.ts' \
  | grep -v 'numfmt-ignore' || true)
if [ -n "$toFixed" ]; then
  echo "✖ .toFixed() in command layer — use the Intl formatters in src/bot/lib/fmt.ts:"
  echo "$toFixed"
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "✓ number checks passed"; fi
exit "$fail"

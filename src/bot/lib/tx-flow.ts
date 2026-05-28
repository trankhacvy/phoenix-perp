import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { type BotError, toBotError } from "./errors.js";
import { solscanUrl } from "./fmt.js";

export const SUBMITTING = "⏳ Submitting transaction…";
export const CONFIRMING = "⏳ Confirming on-chain… (usually 2–5s)";

export const TOAST_SUBMITTING = "Submitting…";

export interface TxSuccessOpts {
  header: string;
  body?: FormattedString;
  signature?: string;
  footer?: FormattedString;
}

export function txSuccess(opts: TxSuccessOpts): FormattedString {
  const parts: FormattedString[] = [fmt`✅ ${FormattedString.b(opts.header)}`];
  if (opts.body) parts.push(opts.body);
  if (opts.signature) {
    parts.push(fmt`${FormattedString.link("View on Solscan →", solscanUrl(opts.signature))}`);
  }
  if (opts.footer) parts.push(opts.footer);
  return FormattedString.join(parts, "\n\n");
}

export function txError(err: unknown, action: string): { msg: FormattedString; be: BotError } {
  const be = toBotError(err);
  const hint = be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``;
  const retry = be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``;
  const msg = fmt`${FormattedString.b(`❌ ${action} failed`)}\n\n${be.userMessage}${hint}${retry}`;
  return { msg, be };
}

export const TX_MSG_OPTS = { link_preview_options: { is_disabled: true } } as const;

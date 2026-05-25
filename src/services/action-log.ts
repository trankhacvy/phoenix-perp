import { toBotError } from "../bot/lib/errors.js";
import { db } from "../db/index.js";
import { actionLogs } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";

const REDACT_PATTERNS = [
  "password",
  "private_key",
  "privatekey",
  "api_key",
  "apikey",
  "secret",
  "token",
  "mnemonic",
  "seed",
  "authorization",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "keypair",
  "secretkey",
  "secret_key",
  "connectionstring",
  "databaseurl",
  "database_url",
  "redisurl",
  "redis_url",
  "webhooksecret",
  "webhook_secret",
];

function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_PATTERNS.some((p) => lower.includes(p));
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function redactValue(v: unknown): Json {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v as Json;
  if (t === "bigint") return (v as bigint).toString();
  if (Array.isArray(v)) return v.map(redactValue);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (Buffer.isBuffer?.(v)) return `[Buffer:${v.length}]`;
  if (t === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const out: { [k: string]: Json } = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = shouldRedact(k) ? "[REDACTED]" : redactValue(val);
      }
      return out;
    }
    return `[${(v as { constructor?: { name?: string } }).constructor?.name ?? "object"}]`;
  }
  return String(v);
}

export function redactArgs(args: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = shouldRedact(k) ? "[REDACTED]" : redactValue(v);
  }
  return out;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface WriteActionLogInput {
  userId?: string;
  command: string;
  args?: Record<string, unknown>;
  outcome: "success" | "error";
  errorCode?: string;
  errorCategory?: string;
  durationMs: number;
  txSignature?: string;
}

export async function writeActionLog(input: WriteActionLogInput): Promise<void> {
  try {
    await db.insert(actionLogs).values({
      id: makeId(),
      userId: input.userId,
      command: input.command,
      args: input.args ? redactArgs(input.args) : null,
      outcome: input.outcome,
      errorCode: input.errorCode,
      errorCategory: input.errorCategory,
      durationMs: input.durationMs,
      txSignature: input.txSignature,
    });
  } catch (err) {
    logger.warn({ err }, "action log write failed");
  }
}

export interface TrackActionMeta {
  userId?: string;
  command: string;
  args?: Record<string, unknown>;
}

export async function trackAction<T>(meta: TrackActionMeta, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await writeActionLog({
      ...meta,
      outcome: "success",
      durationMs: Date.now() - start,
      txSignature: typeof result === "string" ? result : undefined,
    });
    return result;
  } catch (err) {
    const be = toBotError(err);
    await writeActionLog({
      ...meta,
      outcome: "error",
      errorCode: be.code,
      errorCategory: be.category,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

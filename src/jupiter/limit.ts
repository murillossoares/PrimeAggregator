import type { JupiterClient } from './types.js';
import { MinIntervalRateLimiter } from '../lib/rateLimiter.js';

function extractHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/\bHTTP\s+(\d{3})\b/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRetryableStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableError(error: unknown) {
  const status = extractHttpStatus(error);
  if (status !== undefined) return isRetryableStatus(status);
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  const message = error.message.toLowerCase();
  return message.includes('timeout') || message.includes('timed out') || message.includes('fetch failed') || message.includes('econnreset');
}

function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number) {
  const exp = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(maxDelayMs, exp);
  const jitter = Math.floor(Math.random() * Math.min(250, Math.max(0, capped) * 0.25));
  return Math.max(0, Math.floor(capped + jitter));
}

export function withJupiterRateLimit(
  client: JupiterClient,
  config: {
    minIntervalMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  },
): JupiterClient {
  const limiter = new MinIntervalRateLimiter(Math.max(0, Math.floor(config.minIntervalMs)));
  const maxAttempts = Math.max(1, Math.floor(config.maxAttempts));
  const baseDelayMs = Math.max(0, Math.floor(config.baseDelayMs));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(config.maxDelayMs));

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await limiter.schedule(fn);
      } catch (error) {
        const retryable = isRetryableError(error);
        const canRetry = retryable && attempt + 1 < maxAttempts;
        if (!canRetry) throw error;

        const waitMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
        limiter.cooldown(waitMs);
        attempt += 1;
      }
    }
  }

  if (client.kind === 'ultra') {
    return {
      kind: 'ultra',
      order: (params) => call(() => client.order(params)),
      execute: (params) => call(() => client.execute(params)),
    };
  }

  return {
    kind: client.kind,
    quoteExactIn: (params) => call(() => client.quoteExactIn(params)),
    buildSwapTransaction: (params) => call(() => client.buildSwapTransaction(params)),
    buildSwapInstructions: (params) => call(() => client.buildSwapInstructions(params)),
  };
}

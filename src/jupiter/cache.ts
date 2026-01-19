import type { JupiterClient, QuoteResponse } from './types.js';

type CacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

function makeKey(params: { inputMint: string; outputMint: string; amount: string; slippageBps: number }) {
  return `${params.inputMint}:${params.outputMint}:${params.amount}:${params.slippageBps}`;
}

export function withJupiterQuoteCache<T extends JupiterClient>(client: T, ttlMs: number): T {
  if (ttlMs <= 0) return client;
  if (client.kind !== 'swap-v1') return client;

  const cache = new Map<string, CacheEntry<QuoteResponse>>();

  return {
    ...client,
    async quoteExactIn(params) {
      const now = Date.now();
      const includeDexes = params.includeDexes?.length ? params.includeDexes.slice().sort().join(',') : '';
      const excludeDexes = params.excludeDexes?.length ? params.excludeDexes.slice().sort().join(',') : '';
      const key = `${makeKey(params)}:include=${includeDexes}:exclude=${excludeDexes}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now) return await hit.value;

      const value = client.quoteExactIn(params);
      cache.set(key, { expiresAt: now + ttlMs, value });
      try {
        return await value;
      } catch (e) {
        cache.delete(key);
        throw e;
      }
    },
  } as T;
}

import { PublicKey, type Connection } from '@solana/web3.js';

import { getTokenAccountBalanceAtomic } from './tokenUtils.js';

export class TokenBalanceCache {
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<{ amountAtomic: string; decimals: number } | undefined> }>();

  async get(params: { connection: Connection; owner: PublicKey; mint: string; ttlMs: number }) {
    const ttlMs = Math.max(0, Math.floor(params.ttlMs));
    const mint = params.mint.trim();
    if (!mint) return undefined;

    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(mint);
    } catch {
      return undefined;
    }

    const key = `${params.owner.toBase58()}:${mintPk.toBase58()}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return await hit.value;

    const value = getTokenAccountBalanceAtomic({ connection: params.connection, owner: params.owner, mint: mintPk });
    this.cache.set(key, { expiresAt: now + ttlMs, value });
    try {
      return await value;
    } catch (e) {
      this.cache.delete(key);
      throw e;
    }
  }
}


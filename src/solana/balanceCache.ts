import type { Connection, PublicKey } from '@solana/web3.js';

export class BalanceCache {
  private lastFetchedAtMs = 0;
  private lastBalanceLamports = 0;

  async getLamports(params: { connection: Connection; pubkey: PublicKey; ttlMs: number }) {
    const ttlMs = Math.max(0, Math.floor(params.ttlMs));
    const now = Date.now();
    if (ttlMs > 0 && now - this.lastFetchedAtMs < ttlMs) return this.lastBalanceLamports;
    const balance = await params.connection.getBalance(params.pubkey, 'confirmed');
    this.lastFetchedAtMs = now;
    this.lastBalanceLamports = balance;
    return balance;
  }
}


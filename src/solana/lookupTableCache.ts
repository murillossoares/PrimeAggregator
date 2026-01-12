import type { AddressLookupTableAccount, Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';

type CacheEntry = {
  expiresAt: number;
  value?: AddressLookupTableAccount;
  inFlight?: Promise<AddressLookupTableAccount | undefined>;
};

export class LookupTableCache {
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(ttlMs: number) {
    this.ttlMs = Math.max(0, ttlMs);
  }

  async get(connection: Connection, address: string): Promise<AddressLookupTableAccount | undefined> {
    if (this.ttlMs === 0) {
      const res = await connection.getAddressLookupTable(new PublicKey(address));
      return res.value ?? undefined;
    }

    const now = Date.now();
    const existing = this.cache.get(address);
    if (existing && existing.expiresAt > now) {
      if (existing.inFlight) return await existing.inFlight;
      return existing.value;
    }

    const inFlight = (async () => {
      const res = await connection.getAddressLookupTable(new PublicKey(address));
      const value = res.value ?? undefined;
      this.cache.set(address, { expiresAt: Date.now() + this.ttlMs, value });
      return value;
    })();

    this.cache.set(address, { expiresAt: now + this.ttlMs, inFlight });
    try {
      return await inFlight;
    } catch (e) {
      this.cache.delete(address);
      throw e;
    }
  }

  async getMany(
    connection: Connection,
    addresses: string[],
  ): Promise<AddressLookupTableAccount[]> {
    const unique = Array.from(new Set(addresses));
    const results = await Promise.all(unique.map((a) => this.get(connection, a)));
    return results.filter((x): x is AddressLookupTableAccount => Boolean(x));
  }
}


import { Connection, PublicKey } from '@solana/web3.js';

const SPL_MINT_DECIMALS_OFFSET = 44;
const SPL_MINT_MIN_SIZE = 45;

export class MintDecimalsCache {
  private readonly cache = new Map<string, number>();

  async get(connection: Connection, mintAddress: string): Promise<number> {
    const cached = this.cache.get(mintAddress);
    if (cached !== undefined) return cached;

    const mintPubkey = new PublicKey(mintAddress);
    const account = await connection.getAccountInfo(mintPubkey, 'confirmed');
    if (!account?.data) {
      throw new Error(`Mint not found: ${mintAddress}`);
    }
    if (account.data.length < SPL_MINT_MIN_SIZE) {
      throw new Error(`Invalid mint account size for ${mintAddress}: ${account.data.length}`);
    }

    const decimals = account.data[SPL_MINT_DECIMALS_OFFSET];
    this.cache.set(mintAddress, decimals);
    return decimals;
  }
}


import { PublicKey, type Connection } from '@solana/web3.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function getAssociatedTokenAddress(params: { owner: PublicKey; mint: PublicKey }) {
  const [ata] = PublicKey.findProgramAddressSync(
    [params.owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), params.mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

export async function getTokenAccountBalanceAtomic(params: {
  connection: Connection;
  owner: PublicKey;
  mint: PublicKey;
}): Promise<{ amountAtomic: string; decimals: number } | undefined> {
  const ata = getAssociatedTokenAddress({ owner: params.owner, mint: params.mint });
  try {
    const res = await params.connection.getTokenAccountBalance(ata, 'confirmed');
    const amount = res.value.amount;
    const decimals = res.value.decimals;
    if (!/^\d+$/.test(amount)) return undefined;
    return { amountAtomic: amount, decimals };
  } catch {
    return undefined;
  }
}


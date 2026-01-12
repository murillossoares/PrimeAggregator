import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';

function chunk<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function setupWalletTokenAccounts(params: {
  connection: Connection;
  wallet: Keypair;
  mintAddresses: string[];
}): Promise<string[]> {
  const unique = Array.from(new Set(params.mintAddresses));
  const mints = unique
    .map((m) => new PublicKey(m))
    .filter((m) => !m.equals(NATIVE_MINT));

  const instructions = mints.map((mint) => {
    const ata = getAssociatedTokenAddressSync(mint, params.wallet.publicKey);
    return createAssociatedTokenAccountIdempotentInstruction(
      params.wallet.publicKey,
      ata,
      params.wallet.publicKey,
      mint,
    );
  });

  if (instructions.length === 0) {
    return [];
  }

  const signatures: string[] = [];
  for (const group of chunk(instructions, 6)) {
    const tx = new Transaction().add(...group);
    tx.feePayer = params.wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(params.wallet);

    const signature = await params.connection.sendRawTransaction(tx.serialize(), { maxRetries: 2 });
    await params.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    signatures.push(signature);
  }

  return signatures;
}

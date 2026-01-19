import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

function createAssociatedTokenAccountIdempotentInstruction(params: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.ata, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

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
    return createAssociatedTokenAccountIdempotentInstruction({
      payer: params.wallet.publicKey,
      ata,
      owner: params.wallet.publicKey,
      mint,
    });
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

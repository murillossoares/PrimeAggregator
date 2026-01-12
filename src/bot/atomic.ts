import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { JupiterClient, JupiterInstruction, QuoteResponse, SwapInstructionsResponse } from '../jupiter/types.js';
import type { LookupTableCache } from '../solana/lookupTableCache.js';

function toTxInstruction(ix: JupiterInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

function uniqBy<T>(items: T[], keyFn: (item: T) => string) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function ixKey(ix: TransactionInstruction) {
  const keys = ix.keys
    .map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 1 : 0}:${k.isWritable ? 1 : 0}`)
    .join(',');
  return `${ix.programId.toBase58()}:${Buffer.from(ix.data).toString('base64')}:${keys}`;
}

function collectIxBundle(res: SwapInstructionsResponse) {
  return {
    other: res.otherInstructions.map(toTxInstruction),
    computeBudget: res.computeBudgetInstructions.map(toTxInstruction),
    setup: res.setupInstructions.map(toTxInstruction),
    swap: toTxInstruction(res.swapInstruction),
    cleanup: res.cleanupInstruction ? toTxInstruction(res.cleanupInstruction) : undefined,
    alts: res.addressLookupTableAddresses,
  };
}

async function loadLookupTables(
  connection: Connection,
  addresses: string[],
  lookupTableCache?: LookupTableCache,
): Promise<AddressLookupTableAccount[]> {
  if (lookupTableCache) {
    return await lookupTableCache.getMany(connection, addresses);
  }

  const unique = uniqBy(addresses, (a) => a);
  const accounts: AddressLookupTableAccount[] = [];
  for (const addr of unique) {
    const pk = new PublicKey(addr);
    const res = await connection.getAddressLookupTable(pk);
    if (res.value) accounts.push(res.value);
  }
  return accounts;
}

export async function buildAtomicLoopTransaction(params: {
  connection: Connection;
  wallet: Keypair;
  jupiter: Extract<JupiterClient, { kind: 'swap-v1' }>;
  leg1: QuoteResponse;
  leg2: QuoteResponse;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  jitoTipLamports?: number;
  jitoTipAccount?: PublicKey;
  lookupTableCache?: LookupTableCache;
}) {
  const userPublicKey = params.wallet.publicKey.toBase58();

  const [i1, i2] = await Promise.all([
    params.jupiter.buildSwapInstructions({
      quote: params.leg1,
      userPublicKey,
      computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
    }),
    params.jupiter.buildSwapInstructions({
      quote: params.leg2,
      userPublicKey,
      computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
    }),
  ]);

  const b1 = collectIxBundle(i1);
  const b2 = collectIxBundle(i2);

  // ComputeBudget has strict duplicate rules (only one of each type is allowed).
  // Because we combine two swaps, the per-leg dynamic budget from Jupiter can be too low,
  // so we ignore Jupiter's compute budget instructions and set a high limit ourselves.
  const computeBudget: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }),
  ];
  if (params.computeUnitPriceMicroLamports > 0) {
    computeBudget.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: params.computeUnitPriceMicroLamports,
      }),
    );
  }

  // "otherInstructions" may include de-dupe-sensitive instructions, so prefer leg1 only.
  const other = b1.other;

  const setup = uniqBy([...b1.setup, ...b2.setup], ixKey);

  const cleanup = uniqBy(
    [b1.cleanup, b2.cleanup].filter((x): x is TransactionInstruction => Boolean(x)),
    ixKey,
  );

  const instructions: TransactionInstruction[] = [
    ...computeBudget,
    ...other,
    ...setup,
    b1.swap,
    b2.swap,
    ...cleanup,
    ...(params.jitoTipLamports && params.jitoTipLamports > 0 && params.jitoTipAccount
      ? [
          // Prefer tipping after cleanup so WSOL CloseAccount can refund lamports back to payer first.
          SystemProgram.transfer({
            fromPubkey: params.wallet.publicKey,
            toPubkey: params.jitoTipAccount,
            lamports: params.jitoTipLamports,
          }),
        ]
      : []),
  ];

  const lookupTableAccounts = await loadLookupTables(
    params.connection,
    [...b1.alts, ...b2.alts],
    params.lookupTableCache,
  );
  const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash('confirmed');

  const messageV0 = new TransactionMessage({
    payerKey: params.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccounts);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([params.wallet]);

  return { tx, lookupTableAddresses: [...b1.alts, ...b2.alts], lastValidBlockHeight };
}

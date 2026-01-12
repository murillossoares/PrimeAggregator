import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { JupiterClient, QuoteResponse, UltraOrderResponse } from '../jupiter/types.js';
import { decideWithOptionalRust } from './rustDecision.js';
import { buildAtomicLoopTransaction } from './atomic.js';

type ScanResult = {
  kind: 'skipped' | 'built' | 'simulated' | 'executed';
  reason?: string;
};

type Candidate = {
  amountA: string;
  quote1: QuoteResponse | UltraOrderResponse;
  quote2: QuoteResponse | UltraOrderResponse;
  decision: { profitable: boolean; profit: string; conservativeProfit: string };
  feeEstimateLamports: string;
};

function toBigInt(s: string) {
  return BigInt(s);
}

function uniqStrings(values: string[]) {
  return Array.from(new Set(values));
}

function parseAmountList(pair: BotPair): string[] {
  const steps = pair.amountASteps?.length ? pair.amountASteps : [pair.amountA];
  return uniqStrings(steps.filter((v) => /^\d+$/.test(v)));
}

function estimateFeeLamports(params: {
  baseFeeLamports: number;
  rentBufferLamports: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}): string {
  const base = BigInt(params.baseFeeLamports);
  const rent = BigInt(params.rentBufferLamports);
  const priority =
    params.computeUnitPriceMicroLamports > 0
      ? (BigInt(params.computeUnitLimit) * BigInt(params.computeUnitPriceMicroLamports)) / 1_000_000n
      : 0n;
  return (base + rent + priority).toString();
}

function formatDecisionLog(params: {
  pair: BotPair;
  amountA: string;
  quote1: QuoteResponse;
  quote2: QuoteResponse;
  feeEstimateLamports: string;
  profit: string;
  conservativeProfit: string;
  profitable: boolean;
}) {
  return {
    ts: new Date().toISOString(),
    pair: params.pair.name,
    aMint: params.pair.aMint,
    bMint: params.pair.bMint,
    amountA: params.amountA,
    outB: params.quote1.outAmount,
    outBMin: params.quote1.otherAmountThreshold,
    outA: params.quote2.outAmount,
    outAMin: params.quote2.otherAmountThreshold,
    feeEstimateLamports: params.feeEstimateLamports,
    profit: params.profit,
    conservativeProfit: params.conservativeProfit,
    profitable: params.profitable,
  };
}

function pickBestCandidate(candidates: Candidate[]): Candidate | undefined {
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }
    const bestProfit = toBigInt(best.decision.conservativeProfit);
    const currentProfit = toBigInt(candidate.decision.conservativeProfit);
    if (currentProfit > bestProfit) {
      best = candidate;
    }
  }
  return best;
}

async function signAndSendV6Swap(params: {
  connection: Connection;
  wallet: Keypair;
  swapTransactionB64: string;
  lastValidBlockHeight?: number;
}) {
  const raw = Buffer.from(params.swapTransactionB64, 'base64');
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([params.wallet]);
  const signature = await params.connection.sendRawTransaction(tx.serialize(), { maxRetries: 2 });
  const blockhash = tx.message.recentBlockhash;
  const latest = await params.connection.getLatestBlockhash('confirmed');
  await params.connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight: params.lastValidBlockHeight ?? latest.lastValidBlockHeight,
    },
    'confirmed',
  );
  return signature;
}

async function simulateV6Swap(params: {
  connection: Connection;
  wallet: Keypair;
  swapTransactionB64: string;
}) {
  const raw = Buffer.from(params.swapTransactionB64, 'base64');
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([params.wallet]);
  const sim = await params.connection.simulateTransaction(tx, { commitment: 'processed' });
  return sim.value;
}

async function simulateSignedTx(params: { connection: Connection; tx: VersionedTransaction }) {
  const sim = await params.connection.simulateTransaction(params.tx, { commitment: 'processed' });
  return sim.value;
}

async function sendSignedTx(params: {
  connection: Connection;
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
}) {
  const signature = await params.connection.sendRawTransaction(params.tx.serialize(), { maxRetries: 2 });
  const blockhash = params.tx.message.recentBlockhash;
  await params.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight: params.lastValidBlockHeight },
    'confirmed',
  );
  return signature;
}

export async function scanAndMaybeExecute(params: {
  connection: Connection;
  wallet: Keypair;
  jupiter: JupiterClient;
  mode: 'dry-run' | 'live';
  executionStrategy: 'atomic' | 'sequential';
  dryRunBuild: boolean;
  dryRunSimulate: boolean;
  logEvent: Logger;
  baseFeeLamports: number;
  rentBufferLamports: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  pair: BotPair;
  useRustCalc: boolean;
  rustCalcPath: string;
}): Promise<ScanResult> {
  const amounts = parseAmountList(params.pair);
  if (amounts.length === 0) {
    await params.logEvent({ ts: new Date().toISOString(), type: 'skip', pair: params.pair.name, reason: 'no-amounts' });
    return { kind: 'skipped', reason: 'no-amounts' };
  }

  const computeUnitLimit = params.pair.computeUnitLimit ?? params.computeUnitLimit;
  const computeUnitPriceMicroLamports =
    params.pair.computeUnitPriceMicroLamports ?? params.computeUnitPriceMicroLamports;
  const baseFeeLamports = params.pair.baseFeeLamports ?? params.baseFeeLamports;
  const rentBufferLamports = params.pair.rentBufferLamports ?? params.rentBufferLamports;

  const candidates: Candidate[] = [];
  for (const amountA of amounts) {
    if (params.pair.maxNotionalA && toBigInt(amountA) > toBigInt(params.pair.maxNotionalA)) {
      continue;
    }

    const quote1: QuoteResponse | UltraOrderResponse =
      params.jupiter.kind === 'swap-v1'
        ? await params.jupiter.quoteExactIn({
            inputMint: params.pair.aMint,
            outputMint: params.pair.bMint,
            amount: amountA,
            slippageBps: params.pair.slippageBps,
          })
        : await params.jupiter.order({
            inputMint: params.pair.aMint,
            outputMint: params.pair.bMint,
            amount: amountA,
            taker: params.wallet.publicKey.toBase58(),
          });

    const quote1OutMin = quote1.otherAmountThreshold;
    const quote2: QuoteResponse | UltraOrderResponse =
      params.jupiter.kind === 'swap-v1'
        ? await params.jupiter.quoteExactIn({
            inputMint: params.pair.bMint,
            outputMint: params.pair.aMint,
            amount: quote1OutMin,
            slippageBps: params.pair.slippageBps,
          })
        : await params.jupiter.order({
            inputMint: params.pair.bMint,
            outputMint: params.pair.aMint,
            amount: quote1OutMin,
            taker: params.wallet.publicKey.toBase58(),
          });

    const feeEstimateLamports = estimateFeeLamports({
      baseFeeLamports,
      rentBufferLamports,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
    });

    const decision = await decideWithOptionalRust({
      useRust: params.useRustCalc,
      rustCalcPath: params.rustCalcPath,
      amountIn: amountA,
      quote1Out: quote1.outAmount,
      quote1MinOut: quote1.otherAmountThreshold,
      quote2Out: quote2.outAmount,
      quote2MinOut: quote2.otherAmountThreshold,
      minProfit: params.pair.minProfitA,
      feeEstimateLamports,
    });

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'candidate',
      pair: params.pair.name,
      amountA,
      slippageBps: params.pair.slippageBps,
      feeEstimateLamports,
      profit: decision.profit,
      conservativeProfit: decision.conservativeProfit,
      profitable: decision.profitable,
    });

    candidates.push({ amountA, quote1, quote2, decision, feeEstimateLamports });
  }

  const best = pickBestCandidate(candidates);
  if (!best) {
    await params.logEvent({ ts: new Date().toISOString(), type: 'skip', pair: params.pair.name, reason: 'no-candidate' });
    return { kind: 'skipped', reason: 'no-candidate' };
  }

  const shouldBuild = best.decision.profitable || (params.mode === 'dry-run' && params.dryRunBuild);
  if (!shouldBuild) {
    await params.logEvent({ ts: new Date().toISOString(), type: 'skip', pair: params.pair.name, reason: 'not-profitable' });
    return { kind: 'skipped', reason: 'not-profitable' };
  }

  console.log(
    JSON.stringify(
      formatDecisionLog({
        pair: params.pair,
        amountA: best.amountA,
        quote1: best.quote1 as QuoteResponse,
        quote2: best.quote2 as QuoteResponse,
        feeEstimateLamports: best.feeEstimateLamports,
        profit: best.decision.profit,
        conservativeProfit: best.decision.conservativeProfit,
        profitable: best.decision.profitable,
      }),
    ),
  );

  if (params.jupiter.kind === 'ultra') {
    const o1 = best.quote1 as UltraOrderResponse;
    const o2 = best.quote2 as UltraOrderResponse;

    if (!o1.transaction || !o2.transaction) {
      throw new Error('Ultra order returned null transaction');
    }

    const raw1 = Buffer.from(o1.transaction, 'base64');
    const tx1 = VersionedTransaction.deserialize(raw1);
    tx1.sign([params.wallet]);

    const raw2 = Buffer.from(o2.transaction, 'base64');
    const tx2 = VersionedTransaction.deserialize(raw2);
    tx2.sign([params.wallet]);

    if (params.mode === 'dry-run') {
      if (params.dryRunSimulate) {
        const sim1 = await simulateSignedTx({ connection: params.connection, tx: tx1 });
        const sim2 = await simulateSignedTx({ connection: params.connection, tx: tx2 });
        console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, sim1, sim2 }));
        await params.logEvent({ ts: new Date().toISOString(), type: 'simulate', pair: params.pair.name, sim1, sim2 });
        return { kind: 'simulated' };
      }
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, note: 'dry-run build-only' }),
      );
      await params.logEvent({ ts: new Date().toISOString(), type: 'built', pair: params.pair.name, ultra: true });
      return { kind: 'built' };
    }

    const signed1 = Buffer.from(tx1.serialize()).toString('base64');
    const exec1 = await params.jupiter.execute({ signedTransaction: signed1, requestId: o1.requestId });
    const signed2 = Buffer.from(tx2.serialize()).toString('base64');
    const exec2 = await params.jupiter.execute({ signedTransaction: signed2, requestId: o2.requestId });
    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, exec1, exec2 }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, ultra: true, exec1, exec2 });
    return { kind: 'executed' };
  }

  const q1 = best.quote1 as QuoteResponse;
  const q2 = best.quote2 as QuoteResponse;

  if (params.executionStrategy === 'atomic') {
    const built = await buildAtomicLoopTransaction({
      connection: params.connection,
      wallet: params.wallet,
      jupiter: params.jupiter,
      leg1: q1,
      leg2: q2,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
    });

    if (params.mode === 'dry-run') {
      if (params.dryRunSimulate) {
        const sim = await simulateSignedTx({ connection: params.connection, tx: built.tx });
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            pair: params.pair.name,
            atomic: true,
            lookupTables: built.lookupTableAddresses.length,
            sim,
          }),
        );
        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'simulate',
          pair: params.pair.name,
          atomic: true,
          sim,
        });
        return { kind: 'simulated' };
      }
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          pair: params.pair.name,
          atomic: true,
          lookupTables: built.lookupTableAddresses.length,
          lastValidBlockHeight: built.lastValidBlockHeight,
          note: 'dry-run build-only',
        }),
      );
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'built',
        pair: params.pair.name,
        atomic: true,
        lookupTables: built.lookupTableAddresses.length,
      });
      return { kind: 'built' };
    }

    const signature = await sendSignedTx({
      connection: params.connection,
      tx: built.tx,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, atomic: true, signature }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, atomic: true, signature });
    return { kind: 'executed' };
  }

  const swap1 = await params.jupiter.buildSwapTransaction({
    quote: q1,
    userPublicKey: params.wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports,
  });
  const swap2 = await params.jupiter.buildSwapTransaction({
    quote: q2,
    userPublicKey: params.wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports,
  });

  if (params.mode === 'live') {
    const sig1 = await signAndSendV6Swap({
      connection: params.connection,
      wallet: params.wallet,
      swapTransactionB64: swap1.swapTransaction,
      lastValidBlockHeight: swap1.lastValidBlockHeight,
    });
    const sig2 = await signAndSendV6Swap({
      connection: params.connection,
      wallet: params.wallet,
      swapTransactionB64: swap2.swapTransaction,
      lastValidBlockHeight: swap2.lastValidBlockHeight,
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, sig1, sig2 }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, sig1, sig2 });
    return { kind: 'executed' };
  }

  if (!params.dryRunSimulate) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        pair: params.pair.name,
        sequential: true,
        swap1B64Len: swap1.swapTransaction.length,
        swap2B64Len: swap2.swapTransaction.length,
        note: 'dry-run build-only',
      }),
    );
    await params.logEvent({ ts: new Date().toISOString(), type: 'built', pair: params.pair.name, sequential: true });
    return { kind: 'built' };
  }

  const sim1 = await simulateV6Swap({
    connection: params.connection,
    wallet: params.wallet,
    swapTransactionB64: swap1.swapTransaction,
  });
  const sim2 = await simulateV6Swap({
    connection: params.connection,
    wallet: params.wallet,
    swapTransactionB64: swap2.swapTransaction,
  });
  console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, sim1, sim2 }));
  await params.logEvent({ ts: new Date().toISOString(), type: 'simulate', pair: params.pair.name, sim1, sim2 });
  return { kind: 'simulated' };
}

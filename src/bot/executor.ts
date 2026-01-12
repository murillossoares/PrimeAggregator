import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { JupiterClient, QuoteResponse, UltraOrderResponse } from '../jupiter/types.js';
import { buildAtomicLoopTransaction } from './atomic.js';
import { getJitoTipAccountAddress, sendBundleViaJito } from './jitoSender.js';
import type { Candidate } from './scanner.js';
import type { LookupTableCache } from '../solana/lookupTableCache.js';

type ScanResult = {
  kind: 'skipped' | 'built' | 'simulated' | 'executed';
  reason?: string;
};

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

async function simulateSignedTx(params: { connection: Connection; tx: VersionedTransaction }) {
  const sim = await params.connection.simulateTransaction(params.tx, { commitment: 'processed' });
  return sim.value;
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

export async function executeCandidate(params: {
  connection: Connection;
  wallet: Keypair;
  jupiter: JupiterClient;
  mode: 'dry-run' | 'live';
  executionStrategy: 'atomic' | 'sequential';
  dryRunBuild: boolean;
  dryRunSimulate: boolean;
  logEvent: Logger;
  pair: BotPair;
  best: Candidate;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  jitoEnabled: boolean;
  jitoBlockEngineUrl: string;
  jitoTipAccount?: string;
  jitoWaitMs: number;
  jitoFallbackRpc: boolean;
  minBalanceLamports: number;
  lookupTableCache?: LookupTableCache;
}): Promise<ScanResult> {
  const shouldBuild = params.best.decision.profitable || (params.mode === 'dry-run' && params.dryRunBuild);
  if (!shouldBuild) {
    await params.logEvent({ ts: new Date().toISOString(), type: 'skip', pair: params.pair.name, reason: 'not-profitable' });
    return { kind: 'skipped', reason: 'not-profitable' };
  }

  console.log(
    JSON.stringify(
      formatDecisionLog({
        pair: params.pair,
        amountA: params.best.amountA,
        quote1: params.best.quote1 as QuoteResponse,
        quote2: params.best.quote2 as QuoteResponse,
        feeEstimateLamports: params.best.feeEstimateLamports,
        profit: params.best.decision.profit,
        conservativeProfit: params.best.decision.conservativeProfit,
        profitable: params.best.decision.profitable,
      }),
    ),
  );

  if (params.jupiter.kind === 'ultra') {
    const o1 = params.best.quote1 as UltraOrderResponse;
    const o2 = params.best.quote2 as UltraOrderResponse;

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
      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, note: 'dry-run build-only' }));
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

  const q1 = params.best.quote1 as QuoteResponse;
  const q2 = params.best.quote2 as QuoteResponse;

  if (params.executionStrategy === 'atomic') {
    if (params.mode === 'live' && params.minBalanceLamports > 0) {
      const balance = await params.connection.getBalance(params.wallet.publicKey, 'confirmed');
      if (balance < params.minBalanceLamports) {
        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'skip',
          pair: params.pair.name,
          reason: 'min-balance',
          balanceLamports: balance,
          minBalanceLamports: params.minBalanceLamports,
        });
        return { kind: 'skipped', reason: 'min-balance' };
      }
    }

    const wantJito = params.mode === 'live' && params.jitoEnabled;
    const tipLamports = wantJito ? params.best.jitoTipLamports : 0;
    const tipAccount =
      wantJito && tipLamports > 0 ? new PublicKey(getJitoTipAccountAddress(params.jitoTipAccount)) : undefined;

    const built = await buildAtomicLoopTransaction({
      connection: params.connection,
      wallet: params.wallet,
      jupiter: params.jupiter,
      leg1: q1,
      leg2: q2,
      computeUnitLimit: params.computeUnitLimit,
      computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
      jitoTipLamports: tipAccount ? tipLamports : undefined,
      jitoTipAccount: tipAccount,
      lookupTableCache: params.lookupTableCache,
    });

    if (params.mode === 'dry-run') {
      if (params.dryRunSimulate) {
        const sim = await simulateSignedTx({ connection: params.connection, tx: built.tx });
        console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, atomic: true, lookupTables: built.lookupTableAddresses.length, sim }));
        await params.logEvent({ ts: new Date().toISOString(), type: 'simulate', pair: params.pair.name, atomic: true, sim });
        return { kind: 'simulated' };
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, atomic: true, lookupTables: built.lookupTableAddresses.length, lastValidBlockHeight: built.lastValidBlockHeight, note: 'dry-run build-only' }));
      await params.logEvent({ ts: new Date().toISOString(), type: 'built', pair: params.pair.name, atomic: true, lookupTables: built.lookupTableAddresses.length });
      return { kind: 'built' };
    }

    const signature = bs58.encode(built.tx.signatures[0]);

    if (wantJito) {
      const sentAt = Date.now();
      let bundleId: string | undefined;
      let result: any | undefined;
      let jitoError: string | undefined;

      try {
        const sent = await sendBundleViaJito({
          blockEngineUrl: params.jitoBlockEngineUrl,
          authKeypair: params.wallet,
          transaction: built.tx,
          waitMs: params.jitoWaitMs,
        });
        bundleId = sent.bundleId;
        result = sent.result;
      } catch (e) {
        jitoError = String(e);
      }

      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'jito_bundle',
        pair: params.pair.name,
        signature,
        bundleId,
        waitMs: params.jitoWaitMs,
        latencyMs: Date.now() - sentAt,
        result,
        error: jitoError,
      });

      const shouldFallback =
        params.jitoFallbackRpc &&
        params.jitoWaitMs > 0 &&
        (jitoError !== undefined || result === undefined || result.rejected || result.dropped);

      if (shouldFallback) {
        // Rebuild without tip for RPC fallback.
        const rebuilt = await buildAtomicLoopTransaction({
          connection: params.connection,
          wallet: params.wallet,
          jupiter: params.jupiter,
          leg1: q1,
          leg2: q2,
          computeUnitLimit: params.computeUnitLimit,
          computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
          lookupTableCache: params.lookupTableCache,
        });
        const rpcSig = await sendSignedTx({
          connection: params.connection,
          tx: rebuilt.tx,
          lastValidBlockHeight: rebuilt.lastValidBlockHeight,
        });
        console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, atomic: true, jito: true, bundleId, signature, fallbackRpc: true, rpcSig }));
        await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, atomic: true, jito: true, bundleId, signature, fallbackRpc: true, rpcSig });
        return { kind: 'executed' };
      }

      try {
        await params.connection.confirmTransaction(
          { signature, blockhash: built.tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight },
          'confirmed',
        );
      } catch (e) {
        await params.logEvent({ ts: new Date().toISOString(), type: 'confirm_error', pair: params.pair.name, signature, error: String(e) });
      }

      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, atomic: true, jito: true, bundleId, signature }));
      await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, atomic: true, jito: true, bundleId, signature });
      return { kind: 'executed' };
    }

    const sentSignature = await sendSignedTx({ connection: params.connection, tx: built.tx, lastValidBlockHeight: built.lastValidBlockHeight });
    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, atomic: true, signature: sentSignature }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, atomic: true, signature: sentSignature });
    return { kind: 'executed' };
  }

  const swap1 = await params.jupiter.buildSwapTransaction({
    quote: q1,
    userPublicKey: params.wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
  });
  const swap2 = await params.jupiter.buildSwapTransaction({
    quote: q2,
    userPublicKey: params.wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
  });

  if (params.mode === 'live') {
    const sig1 = await signAndSendV6Swap({ connection: params.connection, wallet: params.wallet, swapTransactionB64: swap1.swapTransaction, lastValidBlockHeight: swap1.lastValidBlockHeight });
    const sig2 = await signAndSendV6Swap({ connection: params.connection, wallet: params.wallet, swapTransactionB64: swap2.swapTransaction, lastValidBlockHeight: swap2.lastValidBlockHeight });
    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, sig1, sig2 }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, sig1, sig2 });
    return { kind: 'executed' };
  }

  if (!params.dryRunSimulate) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, sequential: true, swap1B64Len: swap1.swapTransaction.length, swap2B64Len: swap2.swapTransaction.length, note: 'dry-run build-only' }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'built', pair: params.pair.name, sequential: true });
    return { kind: 'built' };
  }

  const sim1 = await simulateV6Swap({ connection: params.connection, wallet: params.wallet, swapTransactionB64: swap1.swapTransaction });
  const sim2 = await simulateV6Swap({ connection: params.connection, wallet: params.wallet, swapTransactionB64: swap2.swapTransaction });
  console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, sim1, sim2 }));
  await params.logEvent({ ts: new Date().toISOString(), type: 'simulate', pair: params.pair.name, sim1, sim2 });
  return { kind: 'simulated' };
}

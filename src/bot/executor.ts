import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { JupiterClient, QuoteResponse, UltraOrderResponse } from '../jupiter/types.js';
import type { OpenOceanClient } from '../openocean/client.js';
import type { OpenOceanSwapData } from '../openocean/types.js';
import { buildAtomicPathTransaction } from './atomic.js';
import { getJitoTipAccountAddress, sendBundleViaJito } from './jitoSender.js';
import type { Candidate } from './scanner.js';
import type { LookupTableCache } from '../solana/lookupTableCache.js';

type ScanResult = {
  kind: 'skipped' | 'built' | 'simulated' | 'executed';
  reason?: string;
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function parseBooleanEnv(name: string, defaultValue: boolean) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

const CONSOLE_VERBOSE = parseBooleanEnv('LOG_VERBOSE', true);

function formatDecisionLog(params: {
  pair: BotPair;
  provider?: string;
  amountA: string;
  quotes: QuoteResponse[];
  feeEstimateLamports: string;
  feeEstimateInA?: string;
  profit: string;
  conservativeProfit: string;
  profitable: boolean;
}) {
  const base = {
    ts: new Date().toISOString(),
    pair: params.pair.name,
    aMint: params.pair.aMint,
    bMint: params.pair.bMint,
    cMint: params.pair.cMint,
    provider: params.provider,
    amountA: params.amountA,
    feeEstimateLamports: params.feeEstimateLamports,
    feeEstimateInA: params.feeEstimateInA,
    profit: params.profit,
    conservativeProfit: params.conservativeProfit,
    profitable: params.profitable,
  };

  if (params.quotes.length === 2) {
    const [q1, q2] = params.quotes;
    return {
      ...base,
      outB: q1?.outAmount,
      outBMin: q1?.otherAmountThreshold,
      outA: q2?.outAmount,
      outAMin: q2?.otherAmountThreshold,
    };
  }

  if (params.quotes.length === 3) {
    const [q1, q2, q3] = params.quotes;
    return {
      ...base,
      triangular: true,
      outB: q1?.outAmount,
      outBMin: q1?.otherAmountThreshold,
      outC: q2?.outAmount,
      outCMin: q2?.otherAmountThreshold,
      outA: q3?.outAmount,
      outAMin: q3?.otherAmountThreshold,
    };
  }

  const last = params.quotes[params.quotes.length - 1];
  return {
    ...base,
    legs: params.quotes.length,
    outFinal: last?.outAmount,
    outFinalMin: last?.otherAmountThreshold,
  };
}

async function simulateSignedTx(params: { connection: Connection; tx: VersionedTransaction }) {
  const sim = await params.connection.simulateTransaction(params.tx, { commitment: 'processed' });
  return sim.value;
}

function isUltraExecutionError(exec: { status: string; code?: number; error?: string } | undefined) {
  if (!exec) return true;
  if (exec.error && exec.error.trim().length > 0) return true;
  if (typeof exec.code === 'number' && Number.isFinite(exec.code) && exec.code !== 0) return true;
  const status = String(exec.status ?? '').toLowerCase();
  return status.includes('fail') || status.includes('error') || status.includes('revert') || status.includes('reject');
}

async function confirmIfSignature(params: { connection: Connection; signature?: string }) {
  const sig = params.signature?.trim();
  if (!sig) return;
  try {
    await params.connection.confirmTransaction(sig, 'confirmed');
  } catch {
    // ignore: confirmation can lag or be dropped; caller logs separately where useful
  }
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

function decodeOpenOceanTxBytes(data: string) {
  const trimmed = data.trim();
  const maybeHex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  const isHex = maybeHex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(maybeHex);
  return Buffer.from(isHex ? maybeHex : trimmed, isHex ? 'hex' : 'base64');
}

function deserializeOpenOceanSwapTx(swap: OpenOceanSwapData) {
  const raw = decodeOpenOceanTxBytes(swap.data);
  return VersionedTransaction.deserialize(raw);
}

function isLikelyMissingIntermediateFunds(sim: { err: unknown; logs?: string[] | null }) {
  if (!sim.err) return false;
  const logs = sim.logs ?? [];
  return logs.some((line) => line.toLowerCase().includes('insufficient funds'));
}

export async function executeCandidate(params: {
  connection: Connection;
  wallet: Keypair;
  quoteJupiter: Extract<JupiterClient, { kind: 'swap-v1' } | { kind: 'v6' }>;
  execJupiter: JupiterClient;
  openOcean?: OpenOceanClient;
  mode: 'dry-run' | 'live';
  executionStrategy: 'atomic' | 'sequential';
  dryRunBuild: boolean;
  dryRunSimulate: boolean;
  livePreflightSimulate: boolean;
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

  const decisionLogQuotes =
    params.best.kind === 'triangular'
      ? [params.best.quote1, params.best.quote2, params.best.quote3]
      : [params.best.quote1, params.best.quote2];

  console.log(
    JSON.stringify(
      formatDecisionLog({
        pair: params.pair,
        provider: params.best.kind === 'loop_openocean' ? 'openocean' : params.execJupiter.kind === 'ultra' ? 'ultra' : 'jupiter',
        amountA: params.best.amountA,
        quotes: decisionLogQuotes as QuoteResponse[],
        feeEstimateLamports: params.best.feeEstimateLamports,
        feeEstimateInA: (params.best as any).feeEstimateInA,
        profit: params.best.decision.profit,
        conservativeProfit: params.best.decision.conservativeProfit,
        profitable: params.best.decision.profitable,
      }),
    ),
  );

  if (params.best.kind === 'loop_openocean') {
    if (params.executionStrategy !== 'sequential') {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        provider: 'openocean',
        reason: 'openocean-requires-sequential',
      });
      return { kind: 'skipped', reason: 'openocean-requires-sequential' };
    }
    if (!params.openOcean) {
      throw new Error('OpenOcean candidate selected but OpenOcean client is missing');
    }

    const account = params.wallet.publicKey.toBase58();
    const swap1 = await params.openOcean.swap({
      inputMint: params.best.quote1.inputMint,
      outputMint: params.best.quote1.outputMint,
      amountAtomic: params.best.amountA,
      slippageBps: params.best.quote1.slippageBps,
      account,
    });
    const tx1 = deserializeOpenOceanSwapTx(swap1);
    tx1.sign([params.wallet]);

    if (params.mode === 'dry-run') {
      if (params.dryRunSimulate) {
        const sim1 = await simulateSignedTx({ connection: params.connection, tx: tx1 });

        const swap2 = await params.openOcean.swap({
          inputMint: params.best.quote2.inputMint,
          outputMint: params.best.quote2.outputMint,
          amountAtomic: params.best.quote1.otherAmountThreshold,
          slippageBps: params.best.quote2.slippageBps,
          account,
        });
        const tx2 = deserializeOpenOceanSwapTx(swap2);
        tx2.sign([params.wallet]);
        const sim2 = await simulateSignedTx({ connection: params.connection, tx: tx2 });

        const sim2Expected = isLikelyMissingIntermediateFunds(sim2);
        const sim2Note = sim2Expected
          ? 'dry-run: leg2 depends on leg1 output; sim2 may fail if wallet has no intermediate balance on-chain'
          : undefined;

        console.log(
          JSON.stringify(
            CONSOLE_VERBOSE
              ? { ts: new Date().toISOString(), pair: params.pair.name, provider: 'openocean', sim1, sim2, sim2Expected, sim2Note }
              : {
                  ts: new Date().toISOString(),
                  pair: params.pair.name,
                  provider: 'openocean',
                  sim1Err: sim1.err,
                  sim2Err: sim2.err,
                  sim2Expected,
                  sim2Note,
                },
          ),
        );
        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'simulate',
          pair: params.pair.name,
          provider: 'openocean',
          sim1,
          sim2,
          sim2Expected,
          sim2Note,
        });
        return { kind: 'simulated' };
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, provider: 'openocean', note: 'dry-run build-only' }));
      await params.logEvent({ ts: new Date().toISOString(), type: 'built', pair: params.pair.name, provider: 'openocean' });
      return { kind: 'built' };
    }

    if (params.livePreflightSimulate) {
      const sim1 = await simulateSignedTx({ connection: params.connection, tx: tx1 });
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'preflight',
        pair: params.pair.name,
        provider: 'openocean',
        sequential: true,
        sim1Err: sim1.err,
      });
      if (sim1.err) {
        console.log(
          JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, provider: 'openocean', preflight: false, sim1Err: sim1.err }),
        );
        return { kind: 'skipped', reason: 'preflight-failed' };
      }
    }

    const latest = await params.connection.getLatestBlockhash('confirmed');
    const sig1 = await sendSignedTx({
      connection: params.connection,
      tx: tx1,
      lastValidBlockHeight: swap1.lastValidBlockHeight ?? latest.lastValidBlockHeight,
    });

    const swap2 = await params.openOcean.swap({
      inputMint: params.best.quote2.inputMint,
      outputMint: params.best.quote2.outputMint,
      amountAtomic: params.best.quote1.otherAmountThreshold,
      slippageBps: params.best.quote2.slippageBps,
      account,
    });
    const tx2 = deserializeOpenOceanSwapTx(swap2);
    tx2.sign([params.wallet]);

    if (params.livePreflightSimulate) {
      const sim2 = await simulateSignedTx({ connection: params.connection, tx: tx2 });
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'preflight',
        pair: params.pair.name,
        provider: 'openocean',
        sequential: true,
        leg: 2,
        sim2Err: sim2.err,
      });
      if (sim2.err) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            pair: params.pair.name,
            provider: 'openocean',
            preflight: false,
            sequential: true,
            leg: 2,
            sig1,
            sim2Err: sim2.err,
          }),
        );
        return { kind: 'skipped', reason: 'preflight-failed-leg2' };
      }
    }

    const sig2 = await sendSignedTx({
      connection: params.connection,
      tx: tx2,
      lastValidBlockHeight: swap2.lastValidBlockHeight ?? latest.lastValidBlockHeight,
    });

    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, provider: 'openocean', sig1, sig2 }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, provider: 'openocean', sig1, sig2 });
    return { kind: 'executed' };
  }

  if (params.execJupiter.kind === 'ultra') {
    if (params.executionStrategy !== 'sequential') {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        ultra: true,
        reason: 'ultra-requires-sequential',
        executionStrategy: params.executionStrategy,
      });
      return { kind: 'skipped', reason: 'ultra-requires-sequential' };
    }

    if (params.pair.cMint) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        ultra: true,
        reason: 'ultra-does-not-support-triangular',
      });
      return { kind: 'skipped', reason: 'ultra-does-not-support-triangular' };
    }

    if (params.pair.aMint !== SOL_MINT) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        ultra: true,
        reason: 'ultra-requires-sol-amint',
        aMint: params.pair.aMint,
      });
      return { kind: 'skipped', reason: 'ultra-requires-sol-amint' };
    }

    if (params.best.kind !== 'loop') {
      throw new Error('Ultra execution only supports loop candidates');
    }

    const taker = params.wallet.publicKey.toBase58();
    const excludeDexes = params.pair.excludeDexes?.length ? params.pair.excludeDexes.join(',') : undefined;

    const o1: UltraOrderResponse = await params.execJupiter.order({
      inputMint: params.pair.aMint,
      outputMint: params.pair.bMint,
      amount: params.best.amountA,
      taker,
      excludeDexes,
    });
    if (!o1.transaction) throw new Error('Ultra order returned null transaction (leg1)');

    const o2: UltraOrderResponse = await params.execJupiter.order({
      inputMint: params.pair.bMint,
      outputMint: params.pair.aMint,
      amount: o1.otherAmountThreshold,
      taker,
      excludeDexes,
    });
    if (!o2.transaction) throw new Error('Ultra order returned null transaction (leg2)');

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
        console.log(
          JSON.stringify(
            CONSOLE_VERBOSE
              ? { ts: new Date().toISOString(), pair: params.pair.name, ultra: true, sim1, sim2 }
              : { ts: new Date().toISOString(), pair: params.pair.name, ultra: true, sim1Err: sim1.err, sim2Err: sim2.err },
          ),
        );
        await params.logEvent({ ts: new Date().toISOString(), type: 'simulate', pair: params.pair.name, sim1, sim2 });
        return { kind: 'simulated' };
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, note: 'dry-run build-only' }));
      await params.logEvent({ ts: new Date().toISOString(), type: 'built', pair: params.pair.name, ultra: true });
      return { kind: 'built' };
    }

    if (params.livePreflightSimulate) {
      const sim1 = await simulateSignedTx({ connection: params.connection, tx: tx1 });
      const sim2 = await simulateSignedTx({ connection: params.connection, tx: tx2 });
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'preflight',
        pair: params.pair.name,
        ultra: true,
        sim1Err: sim1.err,
        sim2Err: sim2.err,
      });
      if (sim1.err || sim2.err) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, preflight: false, sim1Err: sim1.err, sim2Err: sim2.err }));
        return { kind: 'skipped', reason: 'preflight-failed' };
      }
    }

    const signed1 = Buffer.from(tx1.serialize()).toString('base64');
    const exec1 = await params.execJupiter.execute({ signedTransaction: signed1, requestId: o1.requestId });
    if (isUltraExecutionError(exec1)) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        ultra: true,
        reason: 'ultra-exec-failed-leg1',
        exec1,
      });
      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, exec1 }));
      return { kind: 'skipped', reason: 'ultra-exec-failed-leg1' };
    }

    await confirmIfSignature({ connection: params.connection, signature: exec1.signature });

    const signed2 = Buffer.from(tx2.serialize()).toString('base64');
    const exec2 = await params.execJupiter.execute({ signedTransaction: signed2, requestId: o2.requestId });
    if (isUltraExecutionError(exec2)) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        ultra: true,
        reason: 'ultra-exec-failed-leg2',
        exec1,
        exec2,
      });
      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, exec1, exec2 }));
      return { kind: 'skipped', reason: 'ultra-exec-failed-leg2' };
    }

    await confirmIfSignature({ connection: params.connection, signature: exec2.signature });
    console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, ultra: true, exec1, exec2 }));
    await params.logEvent({ ts: new Date().toISOString(), type: 'executed', pair: params.pair.name, ultra: true, exec1, exec2 });
    return { kind: 'executed' };
  }

  if (params.best.kind === 'triangular' && params.executionStrategy !== 'atomic') {
    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'skip',
      pair: params.pair.name,
      reason: 'triangular-requires-atomic',
    });
    return { kind: 'skipped', reason: 'triangular-requires-atomic' };
  }

  const quotes: QuoteResponse[] =
    params.best.kind === 'triangular' ? [params.best.quote1, params.best.quote2, params.best.quote3] : [params.best.quote1, params.best.quote2];

  if (params.executionStrategy === 'atomic') {
    const wantJito = params.mode === 'live' && params.jitoEnabled;
    const tipLamports = wantJito ? params.best.jitoTipLamports : 0;
    const tipAccount =
      wantJito && tipLamports > 0 ? new PublicKey(getJitoTipAccountAddress(params.jitoTipAccount)) : undefined;

    const built = await buildAtomicPathTransaction({
      connection: params.connection,
      wallet: params.wallet,
      jupiter: params.execJupiter,
      legs: quotes,
      computeUnitLimit: params.computeUnitLimit,
      computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
      jitoTipLamports: tipAccount ? tipLamports : undefined,
      jitoTipAccount: tipAccount,
      lookupTableCache: params.lookupTableCache,
    });

    if (params.mode === 'dry-run') {
      if (params.dryRunSimulate) {
        const sim = await simulateSignedTx({ connection: params.connection, tx: built.tx });
        console.log(
          JSON.stringify(
            CONSOLE_VERBOSE
              ? { ts: new Date().toISOString(), pair: params.pair.name, atomic: true, lookupTables: built.lookupTableAddresses.length, sim }
              : {
                  ts: new Date().toISOString(),
                  pair: params.pair.name,
                  atomic: true,
                  lookupTables: built.lookupTableAddresses.length,
                  simErr: sim.err,
                  unitsConsumed: sim.unitsConsumed,
                },
          ),
        );
        await params.logEvent({ ts: new Date().toISOString(), type: 'simulate', pair: params.pair.name, atomic: true, sim });
        return { kind: 'simulated' };
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, atomic: true, lookupTables: built.lookupTableAddresses.length, lastValidBlockHeight: built.lastValidBlockHeight, note: 'dry-run build-only' }));
      await params.logEvent({ ts: new Date().toISOString(), type: 'built', pair: params.pair.name, atomic: true, lookupTables: built.lookupTableAddresses.length });
      return { kind: 'built' };
    }

    const signature = bs58.encode(built.tx.signatures[0]);

    if (params.livePreflightSimulate) {
      const sim = await simulateSignedTx({ connection: params.connection, tx: built.tx });
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'preflight',
        pair: params.pair.name,
        signature,
        err: sim.err,
        unitsConsumed: sim.unitsConsumed,
      });

      if (sim.err) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, preflight: false, err: sim.err }));
        return { kind: 'skipped', reason: 'preflight-failed' };
      }
    }

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
        const rebuilt = await buildAtomicPathTransaction({
          connection: params.connection,
          wallet: params.wallet,
          jupiter: params.execJupiter,
          legs: quotes,
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

  if (params.best.kind === 'triangular') {
    throw new Error('triangular execution reached sequential path unexpectedly');
  }

  const swap1 = await params.execJupiter.buildSwapTransaction({
    quote: quotes[0],
    userPublicKey: params.wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
  });
  const swap2 = await params.execJupiter.buildSwapTransaction({
    quote: quotes[1],
    userPublicKey: params.wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
  });

  if (params.mode === 'live') {
    if (params.livePreflightSimulate) {
      const sim1 = await simulateV6Swap({ connection: params.connection, wallet: params.wallet, swapTransactionB64: swap1.swapTransaction });
      const sim2 = await simulateV6Swap({ connection: params.connection, wallet: params.wallet, swapTransactionB64: swap2.swapTransaction });
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'preflight',
        pair: params.pair.name,
        sequential: true,
        sim1Err: sim1.err,
        sim2Err: sim2.err,
      });
      if (sim1.err || sim2.err) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), pair: params.pair.name, preflight: false, sequential: true, sim1Err: sim1.err, sim2Err: sim2.err }));
        return { kind: 'skipped', reason: 'preflight-failed' };
      }
    }

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
  console.log(
    JSON.stringify(
      CONSOLE_VERBOSE
        ? { ts: new Date().toISOString(), pair: params.pair.name, sim1, sim2 }
        : { ts: new Date().toISOString(), pair: params.pair.name, sim1Err: sim1.err, sim2Err: sim2.err },
    ),
  );
  await params.logEvent({ ts: new Date().toISOString(), type: 'simulate', pair: params.pair.name, sim1, sim2 });
  return { kind: 'simulated' };
}

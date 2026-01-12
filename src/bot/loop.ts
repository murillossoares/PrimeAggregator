import type { Connection, Keypair } from '@solana/web3.js';

import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { JupiterClient } from '../jupiter/types.js';
import type { LookupTableCache } from '../solana/lookupTableCache.js';
import { executeCandidate } from './executor.js';
import { scanPair } from './scanner.js';

type ScanResult = {
  kind: 'skipped' | 'built' | 'simulated' | 'executed';
  reason?: string;
};

export async function scanAndMaybeExecute(params: {
  connection: Connection;
  wallet: Keypair;
  jupiter: JupiterClient;
  mode: 'dry-run' | 'live';
  executionStrategy: 'atomic' | 'sequential';
  dryRunBuild: boolean;
  dryRunSimulate: boolean;
  livePreflightSimulate: boolean;
  logEvent: Logger;
  baseFeeLamports: number;
  rentBufferLamports: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  jitoEnabled: boolean;
  jitoBlockEngineUrl: string;
  jitoTipLamports: number;
  jitoTipMode: 'fixed' | 'dynamic';
  jitoMinTipLamports: number;
  jitoMaxTipLamports: number;
  jitoTipBps: number;
  jitoWaitMs: number;
  jitoFallbackRpc: boolean;
  jitoTipAccount?: string;
  minBalanceLamports: number;
  pair: BotPair;
  useRustCalc: boolean;
  rustCalcPath: string;
  lookupTableCache?: LookupTableCache;
}): Promise<ScanResult> {
  const scanStartedAt = Date.now();
  const scan = await scanPair({
    connection: params.connection,
    wallet: params.wallet,
    jupiter: params.jupiter,
    pair: params.pair,
    logEvent: params.logEvent,
    computeUnitLimit: params.computeUnitLimit,
    computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
    baseFeeLamports: params.baseFeeLamports,
    rentBufferLamports: params.rentBufferLamports,
    jitoEnabled: params.jitoEnabled,
    jitoTipLamports: params.jitoTipLamports,
    jitoTipMode: params.jitoTipMode,
    jitoMinTipLamports: params.jitoMinTipLamports,
    jitoMaxTipLamports: params.jitoMaxTipLamports,
    jitoTipBps: params.jitoTipBps,
    useRustCalc: params.useRustCalc,
    rustCalcPath: params.rustCalcPath,
  });

  await params.logEvent({
    ts: new Date().toISOString(),
    type: 'scan_summary',
    pair: params.pair.name,
    candidates: scan.candidates.length,
    scanMs: Date.now() - scanStartedAt,
  });

  if (!scan.best) {
    await params.logEvent({ ts: new Date().toISOString(), type: 'skip', pair: params.pair.name, reason: 'no-candidate' });
    return { kind: 'skipped', reason: 'no-candidate' };
  }

  return await executeCandidate({
    connection: params.connection,
    wallet: params.wallet,
    jupiter: params.jupiter,
    mode: params.mode,
    executionStrategy: params.executionStrategy,
    dryRunBuild: params.dryRunBuild,
    dryRunSimulate: params.dryRunSimulate,
    livePreflightSimulate: params.livePreflightSimulate,
    logEvent: params.logEvent,
    pair: params.pair,
    best: scan.best,
    computeUnitLimit: scan.computeUnitLimit,
    computeUnitPriceMicroLamports: scan.computeUnitPriceMicroLamports,
    jitoEnabled: params.jitoEnabled,
    jitoBlockEngineUrl: params.jitoBlockEngineUrl,
    jitoTipAccount: params.jitoTipAccount,
    jitoWaitMs: params.jitoWaitMs,
    jitoFallbackRpc: params.jitoFallbackRpc,
    minBalanceLamports: params.minBalanceLamports,
    lookupTableCache: params.lookupTableCache,
  });
}

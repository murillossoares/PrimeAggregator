import type { Connection, Keypair } from '@solana/web3.js';

import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import { sleep } from '../lib/time.js';
import type { JupiterClient } from '../jupiter/types.js';
import type { OpenOceanClient } from '../openocean/client.js';
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
  openOcean?: OpenOceanClient;
  mode: 'dry-run' | 'live';
  executionStrategy: 'atomic' | 'sequential';
  triggerStrategy: 'immediate' | 'avg-window' | 'vwap' | 'bollinger';
  triggerObserveMs: number;
  triggerObserveIntervalMs: number;
  triggerExecuteMs: number;
  triggerExecuteIntervalMs: number;
  triggerBollingerK: number;
  triggerEmaAlpha: number;
  triggerBollingerMinSamples: number;
  triggerMomentumLookback: number;
  triggerTrailDropBps: number;
  triggerEmergencySigma: number;
  triggerAmountMode: 'all' | 'rotate' | 'fixed';
  triggerMaxAmountsPerTick: number;
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
  openOceanObserveEnabled: boolean;
  openOceanExecuteEnabled: boolean;
  openOceanEveryNTicks: number;
  openOceanJupiterGateBps: number;
  openOceanSignaturesEstimate: number;
  minBalanceLamports: number;
  pair: BotPair;
  useRustCalc: boolean;
  rustCalcPath: string;
  lookupTableCache?: LookupTableCache;
}): Promise<ScanResult> {
  function candidateConservativeProfitPpm(candidate: { amountA: string; decision: { conservativeProfit: string } }) {
    const amountA = BigInt(candidate.amountA);
    if (amountA <= 0n) return undefined;
    const profit = BigInt(candidate.decision.conservativeProfit);

    // PPM = profit / amount * 1e6 (1 bps = 100 ppm)
    const ppm = (profit * 1_000_000n) / amountA;
    const asNumber = Number(ppm);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }

  function ppmToBps(ppm: number) {
    return ppm / 100;
  }

  function scanConservativeProfitVwapPpm(scan: { candidates: Array<{ amountA: string; decision: { conservativeProfit: string } }> }) {
    let sumProfit = 0n;
    let sumAmount = 0n;

    for (const candidate of scan.candidates) {
      const amountA = BigInt(candidate.amountA);
      if (amountA <= 0n) continue;
      const profit = BigInt(candidate.decision.conservativeProfit);
      sumProfit += profit;
      sumAmount += amountA;
    }

    if (sumAmount <= 0n) return undefined;
    const ppm = (sumProfit * 1_000_000n) / sumAmount;
    const asNumber = Number(ppm);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }

  function normalizeAmountList(values: string[]) {
    return Array.from(new Set(values.filter((v) => /^\d+$/.test(v))));
  }

  const maxAmountsPerTick = Math.max(0, Math.floor(params.triggerMaxAmountsPerTick));
  const configuredAmounts = normalizeAmountList(
    params.pair.amountASteps?.length ? params.pair.amountASteps : [params.pair.amountA],
  );
  const eligibleAmounts =
    params.pair.maxNotionalA && /^\d+$/.test(params.pair.maxNotionalA)
      ? configuredAmounts.filter((amount) => BigInt(amount) <= BigInt(params.pair.maxNotionalA as string))
      : configuredAmounts;
  let amountCursor = 0;
  const preferredAmountIndex =
    /^\d+$/.test(params.pair.amountA) && eligibleAmounts.includes(params.pair.amountA)
      ? eligibleAmounts.indexOf(params.pair.amountA)
      : 0;
  const fixedAmounts = (() => {
    if (params.triggerAmountMode !== 'fixed') return undefined;
    if (maxAmountsPerTick <= 0) return undefined;
    if (eligibleAmounts.length === 0) return undefined;
    if (maxAmountsPerTick >= eligibleAmounts.length) return eligibleAmounts;
    const picked: string[] = [];
    for (let i = 0; i < maxAmountsPerTick; i++) {
      picked.push(eligibleAmounts[(preferredAmountIndex + i) % eligibleAmounts.length] as string);
    }
    return picked;
  })();

  function pickAmountsOverrideForTick(): string[] | undefined {
    if (params.triggerAmountMode === 'all') return undefined;
    if (maxAmountsPerTick <= 0) return undefined;
    if (eligibleAmounts.length === 0) return undefined;
    if (maxAmountsPerTick >= eligibleAmounts.length) return eligibleAmounts;
    if (params.triggerAmountMode === 'fixed') return fixedAmounts;

    const picked: string[] = [];
    for (let i = 0; i < maxAmountsPerTick; i++) {
      picked.push(eligibleAmounts[(amountCursor + i) % eligibleAmounts.length] as string);
    }
    amountCursor = (amountCursor + maxAmountsPerTick) % eligibleAmounts.length;
    return picked;
  }

  type ScanPhase = 'single' | 'observe' | 'execute';
  const openOceanTicks: Record<ScanPhase, number> = { single: 0, observe: 0, execute: 0 };
  const openOceanEveryNTicks = Math.max(1, Math.floor(params.openOceanEveryNTicks));

  function shouldUseOpenOcean(phase: ScanPhase, force: boolean) {
    if (!params.openOcean) return false;
    const phaseEnabled =
      phase === 'observe' ? params.openOceanObserveEnabled : params.openOceanExecuteEnabled;
    if (!phaseEnabled) return false;
    if (force) return true;

    const tick = openOceanTicks[phase];
    openOceanTicks[phase] = tick + 1;
    return tick % openOceanEveryNTicks === 0;
  }

  async function runScan(phase: ScanPhase, options: { forceOpenOcean?: boolean } = {}) {
    const scanStartedAt = Date.now();
    const forceOpenOcean = Boolean(options.forceOpenOcean);
    const enableOpenOcean = shouldUseOpenOcean(phase, forceOpenOcean);
    const openOceanJupiterGateBps = forceOpenOcean ? undefined : params.openOceanJupiterGateBps;
    const scan = await scanPair({
      connection: params.connection,
      wallet: params.wallet,
      jupiter: params.jupiter,
      openOcean: params.openOcean,
      amountsOverride: pickAmountsOverrideForTick(),
      enableOpenOcean,
      openOceanJupiterGateBps,
      openOceanSignaturesEstimate: params.openOceanSignaturesEstimate,
      executionStrategy: params.executionStrategy,
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
      trigger: params.triggerStrategy,
      candidates: scan.candidates.length,
      scanMs: Date.now() - scanStartedAt,
      openOceanEnabled: enableOpenOcean,
    });

    return scan;
  }

  if (params.triggerStrategy === 'avg-window') {
    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'trigger_start',
      pair: params.pair.name,
      trigger: 'avg-window',
      observeMs: params.triggerObserveMs,
      executeMs: params.triggerExecuteMs,
    });

    const observeStart = Date.now();
    const positiveProfits: bigint[] = [];
    let maxProfit = 0n;

    while (Date.now() - observeStart < params.triggerObserveMs) {
      const tickStartedAt = Date.now();
      const scan = await runScan('observe');

      const best = scan.best;
      if (best) {
        const profit = BigInt(best.decision.conservativeProfit);
        if (profit > 0n) {
          positiveProfits.push(profit);
          if (profit > maxProfit) maxProfit = profit;
        }
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const sleepMs = params.triggerObserveIntervalMs - elapsedMs;
      if (sleepMs > 0) await sleep(sleepMs);
    }

    if (positiveProfits.length === 0) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        trigger: 'avg-window',
        reason: 'no-positive-profit-in-window',
      });
      return { kind: 'skipped', reason: 'no-positive-profit-in-window' };
    }

    const sum = positiveProfits.reduce((acc, v) => acc + v, 0n);
    const avgProfit = sum / BigInt(positiveProfits.length);

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'trigger_stats',
      pair: params.pair.name,
      trigger: 'avg-window',
      samples: positiveProfits.length,
      avgProfitLamports: avgProfit.toString(),
      maxProfitLamports: maxProfit.toString(),
    });

    const executeStart = Date.now();
    while (Date.now() - executeStart < params.triggerExecuteMs) {
      const tickStartedAt = Date.now();
      const scan = await runScan('execute');

      if (scan.best) {
        const profit = BigInt(scan.best.decision.conservativeProfit);
        const meetsAvg = profit >= avgProfit;
        if (meetsAvg && scan.best.decision.profitable) {
          await params.logEvent({
            ts: new Date().toISOString(),
            type: 'trigger_fire',
            pair: params.pair.name,
            trigger: 'avg-window',
            amountA: scan.best.amountA,
            profitLamports: profit.toString(),
            avgProfitLamports: avgProfit.toString(),
          });

          return await executeCandidate({
            connection: params.connection,
            wallet: params.wallet,
            jupiter: params.jupiter,
            openOcean: params.openOcean,
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
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const sleepMs = params.triggerExecuteIntervalMs - elapsedMs;
      if (sleepMs > 0) await sleep(sleepMs);
    }

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'skip',
      pair: params.pair.name,
      trigger: 'avg-window',
      reason: 'execute-window-expired',
      avgProfitLamports: avgProfit.toString(),
      maxProfitLamports: maxProfit.toString(),
    });
    return { kind: 'skipped', reason: 'execute-window-expired' };
  }

  if (params.triggerStrategy === 'vwap') {
    const minSamples = Math.max(2, Math.floor(params.triggerBollingerMinSamples));
    const lookback = Math.max(1, Math.floor(params.triggerMomentumLookback));
    const dropPpm = Math.max(0, Math.floor(params.triggerTrailDropBps * 100));

    const expectedSamples = Math.max(1, Math.round(params.triggerObserveMs / Math.max(1, params.triggerObserveIntervalMs)));
    const autoAlpha = 2 / (expectedSamples + 1);
    const alpha = params.triggerEmaAlpha > 0 ? params.triggerEmaAlpha : autoAlpha;
    const safeAlpha = Math.max(0.01, Math.min(1, alpha));

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'trigger_start',
      pair: params.pair.name,
      trigger: 'vwap',
      observeMs: params.triggerObserveMs,
      executeMs: params.triggerExecuteMs,
      alpha: safeAlpha,
      minSamples,
      lookback,
      dropBps: params.triggerTrailDropBps,
    });

    const observeStart = Date.now();
    let emaPpm: number | undefined;
    let samples = 0;
    let maxPpm: number | undefined;

    while (Date.now() - observeStart < params.triggerObserveMs) {
      const tickStartedAt = Date.now();
      const scan = await runScan('observe');

      if (scan.best) {
        const signalPpm = scanConservativeProfitVwapPpm(scan);
        const bestPpm = candidateConservativeProfitPpm(scan.best);
        if (signalPpm !== undefined) {
          emaPpm = emaPpm === undefined ? signalPpm : emaPpm + safeAlpha * (signalPpm - emaPpm);
          samples += 1;
        }
        if (bestPpm !== undefined && (maxPpm === undefined || bestPpm > maxPpm)) {
          maxPpm = bestPpm;
        }
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const sleepMs = params.triggerObserveIntervalMs - elapsedMs;
      if (sleepMs > 0) await sleep(sleepMs);
    }

    if (emaPpm === undefined || samples < minSamples) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        trigger: 'vwap',
        reason: 'insufficient-samples',
        samples,
        minSamples,
      });
      return { kind: 'skipped', reason: 'insufficient-samples' };
    }

    const targetPpm = emaPpm;

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'trigger_stats',
      pair: params.pair.name,
      trigger: 'vwap',
      samples,
      targetBps: ppmToBps(targetPpm),
      maxBps: maxPpm === undefined ? undefined : ppmToBps(maxPpm),
    });

    const executeStart = Date.now();
    let armed = false;
    let peakPpm = 0;
    let declineTicks = 0;

    while (Date.now() - executeStart < params.triggerExecuteMs) {
      const tickStartedAt = Date.now();
      const scan = await runScan('execute', { forceOpenOcean: armed });

      const best = scan.best;
      const ppm = best ? candidateConservativeProfitPpm(best) : undefined;
      if (!best || ppm === undefined || !best.decision.profitable) {
        armed = false;
        declineTicks = 0;
        peakPpm = 0;
      } else if (!armed) {
        if (ppm >= targetPpm) {
          armed = true;
          peakPpm = ppm;
          declineTicks = 0;
          await params.logEvent({
            ts: new Date().toISOString(),
            type: 'trigger_arm',
            pair: params.pair.name,
            trigger: 'vwap',
            amountA: best.amountA,
            profitBps: ppmToBps(ppm),
            targetBps: ppmToBps(targetPpm),
          });
        }
      } else {
        if (ppm > peakPpm) {
          peakPpm = ppm;
          declineTicks = 0;
        } else if (ppm < peakPpm && peakPpm - ppm >= dropPpm) {
          declineTicks += 1;
          if (declineTicks >= lookback) {
            await params.logEvent({
              ts: new Date().toISOString(),
              type: 'trigger_fire',
              pair: params.pair.name,
              trigger: 'vwap',
              reason: 'trailing-stop',
              amountA: best.amountA,
              profitBps: ppmToBps(ppm),
              peakBps: ppmToBps(peakPpm),
              targetBps: ppmToBps(targetPpm),
              declineTicks,
              lookback,
            });

            return await executeCandidate({
              connection: params.connection,
              wallet: params.wallet,
              jupiter: params.jupiter,
              openOcean: params.openOcean,
              mode: params.mode,
              executionStrategy: params.executionStrategy,
              dryRunBuild: params.dryRunBuild,
              dryRunSimulate: params.dryRunSimulate,
              livePreflightSimulate: params.livePreflightSimulate,
              logEvent: params.logEvent,
              pair: params.pair,
              best,
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
        }
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const sleepMs = params.triggerExecuteIntervalMs - elapsedMs;
      if (sleepMs > 0) await sleep(sleepMs);
    }

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'skip',
      pair: params.pair.name,
      trigger: 'vwap',
      reason: 'execute-window-expired',
      targetBps: ppmToBps(targetPpm),
    });
    return { kind: 'skipped', reason: 'execute-window-expired' };
  }

  if (params.triggerStrategy === 'bollinger') {
    const k = Math.max(0, Math.min(10, params.triggerBollingerK));
    const minSamples = Math.max(2, Math.floor(params.triggerBollingerMinSamples));
    const lookback = Math.max(1, Math.floor(params.triggerMomentumLookback));
    const dropPpm = Math.max(0, Math.floor(params.triggerTrailDropBps * 100));
    const emergencySigma = Math.max(0, Math.min(10, params.triggerEmergencySigma));

    const expectedSamples = Math.max(1, Math.round(params.triggerObserveMs / Math.max(1, params.triggerObserveIntervalMs)));
    const autoAlpha = 2 / (expectedSamples + 1);
    const alpha = params.triggerEmaAlpha > 0 ? params.triggerEmaAlpha : autoAlpha;
    const safeAlpha = Math.max(0.01, Math.min(1, alpha));

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'trigger_start',
      pair: params.pair.name,
      trigger: 'bollinger',
      observeMs: params.triggerObserveMs,
      executeMs: params.triggerExecuteMs,
      k,
      alpha: safeAlpha,
      minSamples,
      lookback,
      dropBps: params.triggerTrailDropBps,
      emergencySigma,
    });

    const observeStart = Date.now();
    let emaPpm: number | undefined;
    let ewmVar = 0;
    let samples = 0;
    let maxPpm: number | undefined;

    while (Date.now() - observeStart < params.triggerObserveMs) {
      const tickStartedAt = Date.now();
      const scan = await runScan('observe');

      if (scan.best) {
        const signalPpm = scanConservativeProfitVwapPpm(scan);
        const bestPpm = candidateConservativeProfitPpm(scan.best);
        if (signalPpm !== undefined) {
          if (emaPpm === undefined) {
            emaPpm = signalPpm;
            ewmVar = 0;
          } else {
            const prev = emaPpm;
            const next = prev + safeAlpha * (signalPpm - prev);
            const residual = signalPpm - next;
            ewmVar = (1 - safeAlpha) * ewmVar + safeAlpha * residual * residual;
            emaPpm = next;
          }
          samples += 1;
          if (bestPpm !== undefined && (maxPpm === undefined || bestPpm > maxPpm)) maxPpm = bestPpm;

          const std = Math.sqrt(ewmVar);
          const emergencyBand = emergencySigma > 0 ? (emaPpm ?? signalPpm) + emergencySigma * std : undefined;
          const shouldEmergencyFire =
            emergencyBand !== undefined &&
            samples >= minSamples &&
            bestPpm !== undefined &&
            bestPpm >= emergencyBand &&
            scan.best.decision.profitable;
          if (shouldEmergencyFire) {
            await params.logEvent({
              ts: new Date().toISOString(),
              type: 'trigger_fire',
              pair: params.pair.name,
              trigger: 'bollinger',
              reason: 'emergency-sigma',
              amountA: scan.best.amountA,
              profitBps: ppmToBps(bestPpm),
              emaBps: ppmToBps(emaPpm ?? signalPpm),
              stdBps: ppmToBps(std),
              emergencyBandBps: ppmToBps(emergencyBand),
            });

            return await executeCandidate({
              connection: params.connection,
              wallet: params.wallet,
              jupiter: params.jupiter,
              openOcean: params.openOcean,
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
        }
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const sleepMs = params.triggerObserveIntervalMs - elapsedMs;
      if (sleepMs > 0) await sleep(sleepMs);
    }

    if (emaPpm === undefined || samples < minSamples) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        trigger: 'bollinger',
        reason: 'insufficient-samples',
        samples,
        minSamples,
      });
      return { kind: 'skipped', reason: 'insufficient-samples' };
    }

    const stdPpm = Math.sqrt(ewmVar);
    const upperBandPpm = emaPpm + k * stdPpm;

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'trigger_stats',
      pair: params.pair.name,
      trigger: 'bollinger',
      samples,
      emaBps: ppmToBps(emaPpm),
      stdBps: ppmToBps(stdPpm),
      upperBandBps: ppmToBps(upperBandPpm),
      maxBps: maxPpm === undefined ? undefined : ppmToBps(maxPpm),
    });

    const executeStart = Date.now();
    let armed = false;
    let peakPpm = 0;
    let declineTicks = 0;

    while (Date.now() - executeStart < params.triggerExecuteMs) {
      const tickStartedAt = Date.now();
      const scan = await runScan('execute', { forceOpenOcean: armed });

      const best = scan.best;
      const ppm = best ? candidateConservativeProfitPpm(best) : undefined;
      if (!best || ppm === undefined || !best.decision.profitable) {
        armed = false;
        declineTicks = 0;
        peakPpm = 0;
      } else if (!armed) {
        if (ppm >= upperBandPpm) {
          armed = true;
          peakPpm = ppm;
          declineTicks = 0;
          await params.logEvent({
            ts: new Date().toISOString(),
            type: 'trigger_arm',
            pair: params.pair.name,
            trigger: 'bollinger',
            amountA: best.amountA,
            profitBps: ppmToBps(ppm),
            upperBandBps: ppmToBps(upperBandPpm),
          });
        }
      } else {
        if (ppm > peakPpm) {
          peakPpm = ppm;
          declineTicks = 0;
        } else if (ppm < peakPpm && peakPpm - ppm >= dropPpm) {
          declineTicks += 1;
          if (declineTicks >= lookback) {
            await params.logEvent({
              ts: new Date().toISOString(),
              type: 'trigger_fire',
              pair: params.pair.name,
              trigger: 'bollinger',
              reason: 'trailing-stop',
              amountA: best.amountA,
              profitBps: ppmToBps(ppm),
              peakBps: ppmToBps(peakPpm),
              upperBandBps: ppmToBps(upperBandPpm),
              declineTicks,
              lookback,
            });

            return await executeCandidate({
              connection: params.connection,
              wallet: params.wallet,
              jupiter: params.jupiter,
              openOcean: params.openOcean,
              mode: params.mode,
              executionStrategy: params.executionStrategy,
              dryRunBuild: params.dryRunBuild,
              dryRunSimulate: params.dryRunSimulate,
              livePreflightSimulate: params.livePreflightSimulate,
              logEvent: params.logEvent,
              pair: params.pair,
              best,
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
        }

        const emergencyBand = emergencySigma > 0 ? emaPpm + emergencySigma * stdPpm : undefined;
        if (emergencyBand !== undefined && ppm >= emergencyBand) {
          await params.logEvent({
            ts: new Date().toISOString(),
            type: 'trigger_fire',
            pair: params.pair.name,
            trigger: 'bollinger',
            reason: 'emergency-sigma',
            amountA: best.amountA,
            profitBps: ppmToBps(ppm),
            emergencyBandBps: ppmToBps(emergencyBand),
          });

          return await executeCandidate({
            connection: params.connection,
            wallet: params.wallet,
            jupiter: params.jupiter,
            openOcean: params.openOcean,
            mode: params.mode,
            executionStrategy: params.executionStrategy,
            dryRunBuild: params.dryRunBuild,
            dryRunSimulate: params.dryRunSimulate,
            livePreflightSimulate: params.livePreflightSimulate,
            logEvent: params.logEvent,
            pair: params.pair,
            best,
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
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const sleepMs = params.triggerExecuteIntervalMs - elapsedMs;
      if (sleepMs > 0) await sleep(sleepMs);
    }

    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'skip',
      pair: params.pair.name,
      trigger: 'bollinger',
      reason: 'execute-window-expired',
      upperBandBps: ppmToBps(upperBandPpm),
      emaBps: ppmToBps(emaPpm),
      stdBps: ppmToBps(stdPpm),
    });
    return { kind: 'skipped', reason: 'execute-window-expired' };
  }

  const scan = await runScan('single');

  if (!scan.best) {
    await params.logEvent({ ts: new Date().toISOString(), type: 'skip', pair: params.pair.name, reason: 'no-candidate' });
    return { kind: 'skipped', reason: 'no-candidate' };
  }

  return await executeCandidate({
    connection: params.connection,
    wallet: params.wallet,
    jupiter: params.jupiter,
    openOcean: params.openOcean,
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

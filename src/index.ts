import 'dotenv/config';

import { loadConfig } from './lib/config.js';
import { sleep } from './lib/time.js';
import { loadWallet } from './solana/wallet.js';
import { makeConnection } from './solana/connection.js';
import { makeJupiterClient } from './jupiter/client.js';
import { withJupiterQuoteCache } from './jupiter/cache.js';
import { withJupiterRateLimit } from './jupiter/limit.js';
import { scanAndMaybeExecute, type PairScanState } from './bot/loop.js';
import { getEnv } from './lib/env.js';
import { createJsonlLogger, type LogEvent, type Logger } from './lib/logger.js';
import { setupWalletTokenAccounts } from './solana/setupWallet.js';
import { forEachLimit } from './lib/concurrency.js';
import { LookupTableCache } from './solana/lookupTableCache.js';
import { PriorityFeeEstimator } from './solana/priorityFees.js';
import { OpenOceanClient } from './openocean/client.js';
import { ProviderCircuitBreaker } from './lib/circuitBreaker.js';
import { AdaptiveTokenBucketRateLimiter } from './lib/rateLimiter.js';
import { startHealthServer } from './lib/health.js';
import { BalanceCache } from './solana/balanceCache.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function hashString32(value: string) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function parseArgs(argv: string[]) {
  const args = new Set(argv.slice(2));
  return {
    once: args.has('--once'),
    setupWallet: args.has('--setup-wallet'),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const env = getEnv();

  let stopRequested = false;
  let stopSignal: string | undefined;
  const requestStop = (signal: string) => {
    stopRequested = true;
    stopSignal = signal;
  };
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));

  const config = await loadConfig(env.configPath);
  const connection = makeConnection({ rpcUrl: env.solanaRpcUrl, wsUrl: env.solanaWsUrl, commitment: env.solanaCommitment });
  const wallet = loadWallet(env.walletSecretKey);
  const balanceLamports = await connection.getBalance(wallet.publicKey, 'confirmed');
  const baseLogEvent = createJsonlLogger(env.logPath, {
    rotateMaxBytes: env.logRotateMaxBytes,
    rotateMaxFiles: env.logRotateMaxFiles,
  });
  const logEvent: Logger = env.logVerbose
    ? baseLogEvent
    : async (event: LogEvent) => {
        const type = typeof event['type'] === 'string' ? (event['type'] as string) : undefined;
        if (type === 'simulate') return;
        if (type === 'candidate' && event['profitable'] !== true) return;
        await baseLogEvent(event);
      };

  const effectiveJitoEnabled = env.jitoEnabled && (env.mode === 'live' || env.dryRunIncludeJitoTip);
  const effectiveJitoTipLamports = effectiveJitoEnabled ? env.jitoTipLamports : 0;
  const priorityFeeEstimator = new PriorityFeeEstimator({
    strategy: env.priorityFeeStrategy,
    level: env.priorityFeeLevel,
    refreshMs: env.priorityFeeRefreshMs,
    maxMicroLamports: env.priorityFeeMaxMicroLamports,
    heliusApiKey: env.heliusApiKey,
    heliusRpcUrl: env.heliusRpcUrl,
    targetAccountLimit: env.priorityFeeTargetAccountLimit,
  });

  const allowPriorityFees = !(effectiveJitoEnabled && !env.priorityFeeWithJito);
  let dynamicComputeUnitPriceMicroLamports = allowPriorityFees ? env.computeUnitPriceMicroLamports : 0;
  if (allowPriorityFees && dynamicComputeUnitPriceMicroLamports === 0 && env.priorityFeeStrategy !== 'off') {
    dynamicComputeUnitPriceMicroLamports = await priorityFeeEstimator.getMicroLamports({ connection });
  }

  const jupBaseRps =
    env.jupRps > 0 ? env.jupRps : 1000 / Math.max(1, env.jupMinIntervalMs);
  const jupiterLimiter = new AdaptiveTokenBucketRateLimiter({
    rps: jupBaseRps,
    burst: env.jupBurst,
    penaltyMs: env.jupAdaptivePenaltyMs,
  });

  const quoteJupiter = makeJupiterClient({
    swapBaseUrl: env.jupQuoteBaseUrl,
    ultraBaseUrl: env.jupUltraBaseUrl,
    apiKey: env.jupApiKey,
    useUltra: false,
  });
  const rateLimitedQuoteJupiter = withJupiterRateLimit(quoteJupiter, {
    minIntervalMs: env.jupMinIntervalMs,
    maxAttempts: env.jupBackoffMaxAttempts,
    baseDelayMs: env.jupBackoffBaseMs,
    maxDelayMs: env.jupBackoffMaxMs,
    limiter: jupiterLimiter,
  });
  const cachedQuoteJupiter = withJupiterQuoteCache(rateLimitedQuoteJupiter, env.quoteCacheTtlMs);

  const execJupiter = makeJupiterClient({
    swapBaseUrl: env.jupSwapBaseUrl,
    ultraBaseUrl: env.jupUltraBaseUrl,
    apiKey: env.jupApiKey,
    useUltra: env.jupExecutionProvider === 'ultra',
  });
  const rateLimitedExecJupiter = withJupiterRateLimit(execJupiter, {
    minIntervalMs: env.jupExecutionProvider === 'ultra' ? env.jupUltraMinIntervalMs : env.jupMinIntervalMs,
    maxAttempts: env.jupExecutionProvider === 'ultra' ? env.jupUltraBackoffMaxAttempts : env.jupBackoffMaxAttempts,
    baseDelayMs: env.jupExecutionProvider === 'ultra' ? env.jupUltraBackoffBaseMs : env.jupBackoffBaseMs,
    maxDelayMs: env.jupExecutionProvider === 'ultra' ? env.jupUltraBackoffMaxMs : env.jupBackoffMaxMs,
    limiter: jupiterLimiter,
  });
  const openOceanBaseRps =
    env.openOceanRps > 0 ? env.openOceanRps : 1000 / Math.max(1, env.openOceanMinIntervalMs);
  const openOceanLimiter = new AdaptiveTokenBucketRateLimiter({
    rps: openOceanBaseRps,
    burst: env.openOceanBurst,
    penaltyMs: env.openOceanAdaptivePenaltyMs,
  });

  const openOcean = env.openOceanEnabled
    ? new OpenOceanClient({
        baseUrl: env.openOceanBaseUrl,
        apiKey: env.openOceanApiKey,
        gasPrice: env.openOceanGasPrice,
        minIntervalMs: env.openOceanMinIntervalMs,
        limiter: openOceanLimiter,
        enabledDexIds: env.openOceanEnabledDexIds,
        disabledDexIds: env.openOceanDisabledDexIds,
        referrer: env.openOceanReferrer,
        referrerFee: env.openOceanReferrerFee,
      })
    : undefined;
  const lookupTableCache = new LookupTableCache(env.lutCacheTtlMs);
  const providerCircuitBreaker = new ProviderCircuitBreaker();
  const balanceCache = new BalanceCache();

  startHealthServer({
    port: env.healthcheckPort,
    getSnapshot: () => ({
      ts: new Date().toISOString(),
      mode: env.mode,
      botProfile: env.botProfile,
      pairs: config.pairs.length,
      jupQuoteKind: cachedQuoteJupiter.kind,
      jupExecKind: rateLimitedExecJupiter.kind,
      jupiterLimiter: jupiterLimiter.snapshot(),
      openOceanLimiter: openOceanLimiter.snapshot(),
    }),
  });

  if (env.openOceanEnabled && env.executionStrategy !== 'sequential') {
    const warning = {
      ts: new Date().toISOString(),
      type: 'warning',
      warning: 'openocean-requires-sequential',
      executionStrategy: env.executionStrategy,
    };
    console.warn(JSON.stringify(warning));
    await logEvent(warning);
  }

  if (rateLimitedExecJupiter.kind === 'ultra' && env.executionStrategy === 'atomic') {
    const warning = {
      ts: new Date().toISOString(),
      type: 'warning',
      warning: 'ultra-is-sequential',
      executionStrategy: env.executionStrategy,
    };
    console.warn(JSON.stringify(warning));
    await logEvent(warning);
  }

  if (rateLimitedExecJupiter.kind === 'ultra') {
    const nonSolA = config.pairs.filter((p) => p.aMint !== SOL_MINT);
    if (nonSolA.length) {
      const warning = {
        ts: new Date().toISOString(),
        type: 'warning',
        warning: 'ultra-requires-sol-amint',
        pairs: nonSolA.map((p) => p.name),
      };
      console.warn(JSON.stringify(warning));
      await logEvent(warning);
    }

    const triangular = config.pairs.filter((p) => Boolean(p.cMint));
    if (triangular.length) {
      const warning = {
        ts: new Date().toISOString(),
        type: 'warning',
        warning: 'ultra-does-not-support-triangular',
        pairs: triangular.map((p) => p.name),
      };
      console.warn(JSON.stringify(warning));
      await logEvent(warning);
    }
  }

  console.log(
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        mode: env.mode,
        botProfile: env.botProfile,
        pairs: config.pairs.length,
        jupQuoteKind: cachedQuoteJupiter.kind,
        jupExecKind: rateLimitedExecJupiter.kind,
        pubkey: wallet.publicKey.toBase58(),
        balanceLamports,
        pairConcurrency: env.pairConcurrency,
        triggerStrategy: env.triggerStrategy,
        triggerAmountMode: env.triggerAmountMode,
        solanaCommitment: env.solanaCommitment,
        solanaWs: Boolean(env.solanaWsUrl),
        logVerbose: env.logVerbose,
        openOceanEnabled: env.openOceanEnabled,
        openOceanObserveEnabled: env.openOceanObserveEnabled,
        openOceanExecuteEnabled: env.openOceanExecuteEnabled,
        openOceanEveryNTicks: env.openOceanEveryNTicks,
        openOceanJupiterGateBps: env.openOceanJupiterGateBps,
        openOceanJupiterNearGateBps: env.openOceanJupiterNearGateBps,
        dryRunIncludeJitoTip: env.dryRunIncludeJitoTip,
        jitoEnabled: effectiveJitoEnabled,
        priorityFeeStrategy: env.priorityFeeStrategy,
        priorityFeeLevel: env.priorityFeeLevel,
        computeUnitPriceMicroLamports: dynamicComputeUnitPriceMicroLamports,
      },
      null,
      2,
    ),
  );

  await logEvent({
    ts: new Date().toISOString(),
    type: 'startup',
    mode: env.mode,
    botProfile: env.botProfile,
    executionStrategy: env.executionStrategy,
    pairs: config.pairs.length,
    pubkey: wallet.publicKey.toBase58(),
    balanceLamports,
    triggerStrategy: env.triggerStrategy,
    triggerAmountMode: env.triggerAmountMode,
    solanaCommitment: env.solanaCommitment,
    solanaWs: Boolean(env.solanaWsUrl),
    logVerbose: env.logVerbose,
    openOceanEnabled: env.openOceanEnabled,
    openOceanObserveEnabled: env.openOceanObserveEnabled,
    openOceanExecuteEnabled: env.openOceanExecuteEnabled,
    openOceanEveryNTicks: env.openOceanEveryNTicks,
    openOceanJupiterGateBps: env.openOceanJupiterGateBps,
    openOceanJupiterNearGateBps: env.openOceanJupiterNearGateBps,
    dryRunIncludeJitoTip: env.dryRunIncludeJitoTip,
    jitoEnabled: effectiveJitoEnabled,
    jupQuoteKind: cachedQuoteJupiter.kind,
    jupExecKind: rateLimitedExecJupiter.kind,
  });

  if (args.setupWallet) {
    const mints = config.pairs.flatMap((pair) => [pair.aMint, pair.bMint]);
    const signatures = await setupWalletTokenAccounts({ connection, wallet, mintAddresses: mints });
    console.log(JSON.stringify({ ts: new Date().toISOString(), setupWallet: true, signatures }, null, 2));
    return;
  }

  if (env.autoSetupWallet) {
    if (env.mode !== 'live') {
      console.log(JSON.stringify({ ts: new Date().toISOString(), autoSetupWallet: true, skipped: true, reason: 'MODE!=live' }));
    } else {
      const mints = config.pairs.flatMap((pair) => [pair.aMint, pair.bMint]);
      const signatures = await setupWalletTokenAccounts({ connection, wallet, mintAddresses: mints });
      console.log(JSON.stringify({ ts: new Date().toISOString(), autoSetupWallet: true, signatures }, null, 2));
      await logEvent({ ts: new Date().toISOString(), type: 'auto_setup_wallet', signatures });
    }
  }

  const cooldowns = new Map<string, number>();
  const pairScanStateByName = new Map<string, PairScanState>();
  const nextScanAtMs = new Map<string, number>();
  const schedulerSpreadMs = Math.max(1, Math.floor(env.pollIntervalMs));
  if (!args.once) {
    const now = Date.now();
    for (const pair of config.pairs) {
      const offset = env.pairSchedulerSpread ? hashString32(pair.name) % schedulerSpreadMs : 0;
      nextScanAtMs.set(pair.name, now + offset);
    }
  }

  let totalErrors = 0;
  let consecutiveErrors = 0;
  do {
    if (stopRequested) break;
    const now = Date.now();
    const walletBalanceLamportsLive = await balanceCache.getLamports({
      connection,
      pubkey: wallet.publicKey,
      ttlMs: Math.max(0, Math.floor(env.balanceRefreshMs)),
    });
    const eligiblePairs = (() => {
      if (args.once) return config.pairs;

      return config.pairs.filter((pair) => {
        const cooldownUntil = cooldowns.get(pair.name) ?? 0;
        if (now < cooldownUntil) return false;
        const nextScanAt = nextScanAtMs.get(pair.name) ?? 0;
        return now >= nextScanAt;
      });
    })();

    if (!args.once && eligiblePairs.length === 0) {
      let nextWakeAt = now + env.pollIntervalMs;
      for (const pair of config.pairs) {
        const cooldownUntil = cooldowns.get(pair.name) ?? 0;
        const nextScanAt = nextScanAtMs.get(pair.name) ?? 0;
        const nextAt = Math.max(cooldownUntil, nextScanAt);
        if (nextAt > 0 && nextAt < nextWakeAt) nextWakeAt = nextAt;
      }
      const sleepMs = Math.max(5, Math.min(env.pollIntervalMs, nextWakeAt - now));
      await sleep(sleepMs);
      continue;
    }

    if (allowPriorityFees && env.computeUnitPriceMicroLamports === 0 && env.priorityFeeStrategy !== 'off') {
      dynamicComputeUnitPriceMicroLamports = await priorityFeeEstimator.getMicroLamports({ connection });
    }

    await forEachLimit(eligiblePairs, env.pairConcurrency, async (pair) => {
      if (stopRequested) return;
      if (!args.once) nextScanAtMs.set(pair.name, Date.now() + env.pollIntervalMs);
      try {
        const state =
          pairScanStateByName.get(pair.name) ??
          ({
            amountCursor: 0,
            openOceanTicks: { single: 0, observe: 0, execute: 0 },
          } satisfies PairScanState);
        pairScanStateByName.set(pair.name, state);

        const result = await scanAndMaybeExecute({
          connection,
          wallet,
          walletBalanceLamports: walletBalanceLamportsLive,
          quoteJupiter: cachedQuoteJupiter,
          execJupiter: rateLimitedExecJupiter,
          openOcean,
          providerCircuitBreaker,
          state,
          mode: env.mode,
          executionStrategy: env.executionStrategy,
          triggerStrategy: env.triggerStrategy,
          triggerObserveMs: env.triggerObserveMs,
          triggerObserveIntervalMs: env.triggerObserveIntervalMs,
          triggerExecuteMs: env.triggerExecuteMs,
          triggerExecuteIntervalMs: env.triggerExecuteIntervalMs,
          triggerBollingerK: env.triggerBollingerK,
          triggerEmaAlpha: env.triggerEmaAlpha,
          triggerBollingerMinSamples: env.triggerBollingerMinSamples,
          triggerMomentumLookback: env.triggerMomentumLookback,
          triggerTrailDropBps: env.triggerTrailDropBps,
          triggerEmergencySigma: env.triggerEmergencySigma,
          triggerAmountMode: env.triggerAmountMode,
          triggerMaxAmountsPerTick: env.triggerMaxAmountsPerTick,
          dryRunBuild: env.dryRunBuild,
          dryRunSimulate: env.dryRunSimulate,
          livePreflightSimulate: env.livePreflightSimulate,
          logEvent,
          baseFeeLamports: env.baseFeeLamports,
          rentBufferLamports: env.rentBufferLamports,
          computeUnitLimit: env.computeUnitLimit,
          computeUnitPriceMicroLamports: dynamicComputeUnitPriceMicroLamports,
          jitoEnabled: effectiveJitoEnabled,
          jitoBlockEngineUrl: env.jitoBlockEngineUrl,
          jitoTipLamports: effectiveJitoTipLamports,
          jitoTipMode: env.jitoTipMode,
          jitoMinTipLamports: env.jitoMinTipLamports,
          jitoMaxTipLamports: env.jitoMaxTipLamports,
          jitoTipBps: env.jitoTipBps,
          jitoWaitMs: env.jitoWaitMs,
          jitoFallbackRpc: env.jitoFallbackRpc,
          jitoTipAccount: env.jitoTipAccount,
          openOceanObserveEnabled: env.openOceanObserveEnabled,
          openOceanExecuteEnabled: env.openOceanExecuteEnabled,
          openOceanEveryNTicks: env.openOceanEveryNTicks,
          openOceanJupiterGateBps: env.openOceanJupiterGateBps,
          openOceanJupiterNearGateBps: env.openOceanJupiterNearGateBps,
          openOceanSignaturesEstimate: env.openOceanSignaturesEstimate,
          feeConversionCacheTtlMs: env.feeConversionCacheTtlMs,
          jup429CooldownMs: env.jup429CooldownMs,
          openOcean429CooldownMs: env.openOcean429CooldownMs,
          minBalanceLamports: env.minBalanceLamports,
          dynamicAmountMode: env.dynamicAmountMode,
          dynamicAmountBps: env.dynamicAmountBps,
          dynamicAmountMinAtomic: env.dynamicAmountMinAtomic,
          dynamicAmountMaxAtomic: env.dynamicAmountMaxAtomic,
          pair,
          useRustCalc: env.useRustCalc,
          rustCalcPath: env.rustCalcPath,
          lookupTableCache,
        });
        consecutiveErrors = 0;
        if (pair.cooldownMs > 0 && result.kind !== 'skipped') {
          cooldowns.set(pair.name, Date.now() + pair.cooldownMs);
        }
      } catch (error) {
        totalErrors += 1;
        consecutiveErrors += 1;

        if (pair.cooldownMs > 0) {
          cooldowns.set(pair.name, Date.now() + pair.cooldownMs);
        }
        await logEvent({ ts: new Date().toISOString(), type: 'error', pair: pair.name, error: String(error) });
        console.error(JSON.stringify({ ts: new Date().toISOString(), pair: pair.name, error: String(error) }, null, 2));

        if (env.maxErrorsBeforeExit > 0 && totalErrors >= env.maxErrorsBeforeExit) {
          await logEvent({ ts: new Date().toISOString(), type: 'exit', reason: 'max-errors', totalErrors });
          process.exitCode = 1;
          throw error;
        }
        if (env.maxConsecutiveErrorsBeforeExit > 0 && consecutiveErrors >= env.maxConsecutiveErrorsBeforeExit) {
          await logEvent({ ts: new Date().toISOString(), type: 'exit', reason: 'max-consecutive-errors', consecutiveErrors });
          process.exitCode = 1;
          throw error;
        }
      }
    });

    if (args.once || stopRequested) break;
  } while (true);

  if (stopRequested) {
    await logEvent({ ts: new Date().toISOString(), type: 'shutdown', reason: stopSignal ?? 'signal' });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

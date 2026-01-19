import 'dotenv/config';

import { loadConfig } from './lib/config.js';
import { sleep } from './lib/time.js';
import { loadWallet } from './solana/wallet.js';
import { makeConnection } from './solana/connection.js';
import { makeJupiterClient } from './jupiter/client.js';
import { withJupiterQuoteCache } from './jupiter/cache.js';
import { withJupiterRateLimit } from './jupiter/limit.js';
import { scanAndMaybeExecute } from './bot/loop.js';
import { getEnv } from './lib/env.js';
import { createJsonlLogger, type LogEvent, type Logger } from './lib/logger.js';
import { setupWalletTokenAccounts } from './solana/setupWallet.js';
import { forEachLimit } from './lib/concurrency.js';
import { LookupTableCache } from './solana/lookupTableCache.js';
import { PriorityFeeEstimator } from './solana/priorityFees.js';
import { OpenOceanClient } from './openocean/client.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

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

  const jupiter = makeJupiterClient({
    swapBaseUrl: env.jupSwapBaseUrl,
    ultraBaseUrl: env.jupUltraBaseUrl,
    apiKey: env.jupApiKey,
    useUltra: env.jupUseUltra,
  });
  const rateLimitedJupiter = withJupiterRateLimit(jupiter, {
    minIntervalMs: env.jupMinIntervalMs,
    maxAttempts: env.jupBackoffMaxAttempts,
    baseDelayMs: env.jupBackoffBaseMs,
    maxDelayMs: env.jupBackoffMaxMs,
  });
  const cachedJupiter = withJupiterQuoteCache(rateLimitedJupiter, env.quoteCacheTtlMs);
  const openOcean = env.openOceanEnabled
    ? new OpenOceanClient({
        baseUrl: env.openOceanBaseUrl,
        apiKey: env.openOceanApiKey,
        gasPrice: env.openOceanGasPrice,
        minIntervalMs: env.openOceanMinIntervalMs,
        enabledDexIds: env.openOceanEnabledDexIds,
        disabledDexIds: env.openOceanDisabledDexIds,
        referrer: env.openOceanReferrer,
        referrerFee: env.openOceanReferrerFee,
      })
    : undefined;
  const lookupTableCache = new LookupTableCache(env.lutCacheTtlMs);

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

  if (jupiter.kind === 'ultra' && env.executionStrategy === 'atomic') {
    const warning = {
      ts: new Date().toISOString(),
      type: 'warning',
      warning: 'ultra-is-sequential',
      executionStrategy: env.executionStrategy,
    };
    console.warn(JSON.stringify(warning));
    await logEvent(warning);
  }

  if (jupiter.kind === 'ultra') {
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
        useUltra: jupiter.kind,
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
    dryRunIncludeJitoTip: env.dryRunIncludeJitoTip,
    jitoEnabled: effectiveJitoEnabled,
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
  let totalErrors = 0;
  let consecutiveErrors = 0;
  do {
    if (stopRequested) break;
    const now = Date.now();
    const eligiblePairs = config.pairs.filter((pair) => {
      const nextAllowedAt = cooldowns.get(pair.name);
      return !(nextAllowedAt && now < nextAllowedAt);
    });

    if (allowPriorityFees && env.computeUnitPriceMicroLamports === 0 && env.priorityFeeStrategy !== 'off') {
      dynamicComputeUnitPriceMicroLamports = await priorityFeeEstimator.getMicroLamports({ connection });
    }

    await forEachLimit(eligiblePairs, env.pairConcurrency, async (pair) => {
      if (stopRequested) return;
      try {
        const result = await scanAndMaybeExecute({
          connection,
          wallet,
          jupiter: cachedJupiter,
          openOcean,
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
          openOceanSignaturesEstimate: env.openOceanSignaturesEstimate,
          minBalanceLamports: env.minBalanceLamports,
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
    await sleep(env.pollIntervalMs);
  } while (true);

  if (stopRequested) {
    await logEvent({ ts: new Date().toISOString(), type: 'shutdown', reason: stopSignal ?? 'signal' });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

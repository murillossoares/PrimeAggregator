import { z } from 'zod';

const ModeSchema = z.enum(['dry-run', 'live']);
const ExecutionStrategySchema = z.enum(['atomic', 'sequential']);
const JitoTipModeSchema = z.enum(['fixed', 'dynamic']);
const PriorityFeeStrategySchema = z.enum(['off', 'rpc-recent', 'helius']);
const PriorityFeeLevelSchema = z.enum(['min', 'low', 'medium', 'high', 'veryHigh', 'unsafeMax', 'recommended']);
const SolanaCommitmentSchema = z.enum(['processed', 'confirmed', 'finalized']);
const TriggerStrategySchema = z.enum(['immediate', 'avg-window', 'vwap', 'bollinger']);
const TriggerAmountModeSchema = z.enum(['all', 'rotate', 'fixed']);

function parseBoolean(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseIntOr(value: string | undefined, defaultValue: number) {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseFloatOr(value: string | undefined, defaultValue: number) {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function getEnv() {
  const mode = ModeSchema.parse(process.env.MODE ?? 'dry-run');
  const executionStrategy = ExecutionStrategySchema.parse(process.env.EXECUTION_STRATEGY ?? 'atomic');
  const triggerStrategy = TriggerStrategySchema.parse(process.env.TRIGGER_STRATEGY ?? 'immediate');
  const triggerObserveMs = parseIntOr(process.env.TRIGGER_OBSERVE_MS, 30_000);
  const triggerObserveIntervalMs = parseIntOr(process.env.TRIGGER_OBSERVE_INTERVAL_MS, 1000);
  const triggerExecuteMs = parseIntOr(process.env.TRIGGER_EXECUTE_MS, 10_000);
  const triggerExecuteIntervalMs = parseIntOr(process.env.TRIGGER_EXECUTE_INTERVAL_MS, 500);
  const triggerBollingerK = parseFloatOr(process.env.TRIGGER_BOLLINGER_K, 1.5);
  const triggerEmaAlpha = parseFloatOr(process.env.TRIGGER_EMA_ALPHA, 0);
  const triggerBollingerMinSamples = parseIntOr(process.env.TRIGGER_BOLLINGER_MIN_SAMPLES, 10);
  const triggerMomentumLookback = parseIntOr(process.env.TRIGGER_MOMENTUM_LOOKBACK, 2);
  const triggerTrailDropBps = parseIntOr(process.env.TRIGGER_TRAIL_DROP_BPS, 1);
  const triggerEmergencySigma = parseFloatOr(process.env.TRIGGER_EMERGENCY_SIGMA, 0);
  const triggerAmountMode = TriggerAmountModeSchema.parse(process.env.TRIGGER_AMOUNT_MODE ?? 'rotate');
  const triggerMaxAmountsPerTick = parseIntOr(process.env.TRIGGER_MAX_AMOUNTS_PER_TICK, 1);
  const dryRunBuild = parseBoolean(process.env.DRY_RUN_BUILD, false);
  const dryRunSimulate = parseBoolean(process.env.DRY_RUN_SIMULATE, false);
  const dryRunIncludeJitoTip = parseBoolean(process.env.DRY_RUN_INCLUDE_JITO_TIP, false);
  const livePreflightSimulate = parseBoolean(process.env.LIVE_PREFLIGHT_SIMULATE, true);
  const priorityFeeStrategy = PriorityFeeStrategySchema.parse(process.env.PRIORITY_FEE_STRATEGY ?? 'off');
  const priorityFeeLevel = PriorityFeeLevelSchema.parse(process.env.PRIORITY_FEE_LEVEL ?? 'recommended');
  const priorityFeeRefreshMs = parseIntOr(process.env.PRIORITY_FEE_REFRESH_MS, 1000);
  const priorityFeeMaxMicroLamports = parseIntOr(process.env.PRIORITY_FEE_MAX_MICRO_LAMPORTS, 50_000_000);
  const priorityFeeTargetAccountLimit = parseIntOr(process.env.PRIORITY_FEE_TARGET_ACCOUNT_LIMIT, 16);
  const priorityFeeWithJito = parseBoolean(process.env.PRIORITY_FEE_WITH_JITO, false);
  const heliusApiKey = process.env.HELIUS_API_KEY;
  const heliusRpcUrl = process.env.HELIUS_RPC_URL;
  const logPath = process.env.LOG_PATH ?? './logs/events.jsonl';
  const baseFeeLamports = parseIntOr(process.env.BASE_FEE_LAMPORTS, 5000);
  const rentBufferLamports = parseIntOr(process.env.RENT_BUFFER_LAMPORTS, 0);
  const computeUnitLimit = parseIntOr(process.env.COMPUTE_UNIT_LIMIT, 1_400_000);
  const computeUnitPriceMicroLamports = parseIntOr(process.env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS, 0);
  const quoteCacheTtlMs = parseIntOr(process.env.QUOTE_CACHE_TTL_MS, 250);
  const lutCacheTtlMs = parseIntOr(process.env.LUT_CACHE_TTL_MS, 60_000);
  const pairConcurrency = parseIntOr(process.env.PAIR_CONCURRENCY, 2);
  const minBalanceLamports = parseIntOr(process.env.MIN_BALANCE_LAMPORTS, 0);
  const maxErrorsBeforeExit = parseIntOr(process.env.MAX_ERRORS_BEFORE_EXIT, 0);
  const maxConsecutiveErrorsBeforeExit = parseIntOr(process.env.MAX_CONSECUTIVE_ERRORS_BEFORE_EXIT, 0);
  const autoSetupWallet = parseBoolean(process.env.AUTO_SETUP_WALLET, false);
  const jitoEnabled = parseBoolean(process.env.JITO_ENABLED, false);
  const jitoBlockEngineUrl = process.env.JITO_BLOCK_ENGINE_URL ?? 'https://amsterdam.mainnet.block-engine.jito.wtf';
  const jitoTipLamports = parseIntOr(process.env.JITO_TIP_LAMPORTS, 10_000);
  const jitoTipMode = JitoTipModeSchema.parse(process.env.JITO_TIP_MODE ?? 'fixed');
  const jitoMinTipLamports = parseIntOr(process.env.JITO_MIN_TIP_LAMPORTS, 5_000);
  const jitoMaxTipLamports = parseIntOr(process.env.JITO_MAX_TIP_LAMPORTS, 50_000);
  const jitoTipBps = parseIntOr(process.env.JITO_TIP_BPS, 2000);
  const jitoWaitMs = parseIntOr(process.env.JITO_WAIT_MS, 0);
  const jitoFallbackRpc = parseBoolean(process.env.JITO_FALLBACK_RPC, false);
  const jitoTipAccount = process.env.JITO_TIP_ACCOUNT;

  const solanaRpcUrl = z.string().min(1).parse(process.env.SOLANA_RPC_URL);
  const solanaWsUrl = process.env.SOLANA_WS_URL;
  const solanaCommitment = SolanaCommitmentSchema.parse(process.env.SOLANA_COMMITMENT ?? 'confirmed');
  const walletSecretKey = z.string().min(1).parse(process.env.WALLET_SECRET_KEY);

  const configPath = process.env.CONFIG_PATH ?? './config.json';
  const pollIntervalMs = parseIntOr(process.env.POLL_INTERVAL_MS, 500);

  const jupSwapBaseUrl = process.env.JUP_SWAP_BASE_URL ?? 'https://api.jup.ag';
  const jupUltraBaseUrl = process.env.JUP_ULTRA_BASE_URL ?? 'https://api.jup.ag';
  const jupApiKey = process.env.JUP_API_KEY;
  const jupUseUltra = parseBoolean(process.env.JUP_USE_ULTRA, false);
  const jupMinIntervalMs = parseIntOr(process.env.JUP_MIN_INTERVAL_MS, 150);
  const jupBackoffMaxAttempts = parseIntOr(process.env.JUP_BACKOFF_MAX_ATTEMPTS, 4);
  const jupBackoffBaseMs = parseIntOr(process.env.JUP_BACKOFF_BASE_MS, 250);
  const jupBackoffMaxMs = parseIntOr(process.env.JUP_BACKOFF_MAX_MS, 5000);

  const openOceanEnabled = parseBoolean(process.env.OPENOCEAN_ENABLED, false);
  const openOceanBaseUrl = process.env.OPENOCEAN_BASE_URL ?? 'https://open-api.openocean.finance/v4/solana';
  const openOceanApiKey = process.env.OPENOCEAN_API_KEY;
  const openOceanGasPrice = parseIntOr(process.env.OPENOCEAN_GAS_PRICE, 5);
  const openOceanMinIntervalMs = parseIntOr(process.env.OPENOCEAN_MIN_INTERVAL_MS, 1200);
  const openOceanSignaturesEstimate = parseIntOr(process.env.OPENOCEAN_SIGNATURES_ESTIMATE, 3);
  const openOceanObserveEnabled = parseBoolean(process.env.OPENOCEAN_OBSERVE_ENABLED, false);
  const openOceanExecuteEnabled = parseBoolean(process.env.OPENOCEAN_EXECUTE_ENABLED, true);
  const openOceanEveryNTicks = parseIntOr(process.env.OPENOCEAN_EVERY_N_TICKS, 2);
  const openOceanJupiterGateBps = parseIntOr(process.env.OPENOCEAN_JUPITER_GATE_BPS, -250);

  const useRustCalc = parseBoolean(process.env.USE_RUST_CALC, false);
  const rustCalcPath = process.env.RUST_CALC_PATH ?? './target/release/arb_calc';

  return {
    mode,
    executionStrategy,
    triggerStrategy,
    triggerObserveMs,
    triggerObserveIntervalMs,
    triggerExecuteMs,
    triggerExecuteIntervalMs,
    triggerBollingerK,
    triggerEmaAlpha,
    triggerBollingerMinSamples,
    triggerMomentumLookback,
    triggerTrailDropBps,
    triggerEmergencySigma,
    triggerAmountMode,
    triggerMaxAmountsPerTick,
    dryRunBuild,
    dryRunSimulate,
    dryRunIncludeJitoTip,
    livePreflightSimulate,
    priorityFeeStrategy,
    priorityFeeLevel,
    priorityFeeRefreshMs,
    priorityFeeMaxMicroLamports,
    priorityFeeTargetAccountLimit,
    priorityFeeWithJito,
    heliusApiKey,
    heliusRpcUrl,
    logPath,
    baseFeeLamports,
    rentBufferLamports,
    computeUnitLimit,
    computeUnitPriceMicroLamports,
    quoteCacheTtlMs,
    lutCacheTtlMs,
    pairConcurrency,
    minBalanceLamports,
    maxErrorsBeforeExit,
    maxConsecutiveErrorsBeforeExit,
    autoSetupWallet,
    jitoEnabled,
    jitoBlockEngineUrl,
    jitoTipLamports,
    jitoTipMode,
    jitoMinTipLamports,
    jitoMaxTipLamports,
    jitoTipBps,
    jitoWaitMs,
    jitoFallbackRpc,
    jitoTipAccount,
    solanaRpcUrl,
    solanaWsUrl,
    solanaCommitment,
    walletSecretKey,
    configPath,
    pollIntervalMs,
    jupSwapBaseUrl,
    jupUltraBaseUrl,
    jupApiKey,
    jupUseUltra,
    jupMinIntervalMs,
    jupBackoffMaxAttempts,
    jupBackoffBaseMs,
    jupBackoffMaxMs,
    openOceanEnabled,
    openOceanBaseUrl,
    openOceanApiKey,
    openOceanGasPrice,
    openOceanMinIntervalMs,
    openOceanSignaturesEstimate,
    openOceanObserveEnabled,
    openOceanExecuteEnabled,
    openOceanEveryNTicks,
    openOceanJupiterGateBps,
    useRustCalc,
    rustCalcPath,
  };
}

import { z } from 'zod';

const ModeSchema = z.enum(['dry-run', 'live']);
const ExecutionStrategySchema = z.enum(['atomic', 'sequential']);

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

export function getEnv() {
  const mode = ModeSchema.parse(process.env.MODE ?? 'dry-run');
  const executionStrategy = ExecutionStrategySchema.parse(process.env.EXECUTION_STRATEGY ?? 'atomic');
  const dryRunBuild = parseBoolean(process.env.DRY_RUN_BUILD, false);
  const dryRunSimulate = parseBoolean(process.env.DRY_RUN_SIMULATE, false);
  const logPath = process.env.LOG_PATH ?? './logs/events.jsonl';
  const baseFeeLamports = parseIntOr(process.env.BASE_FEE_LAMPORTS, 5000);
  const rentBufferLamports = parseIntOr(process.env.RENT_BUFFER_LAMPORTS, 0);
  const computeUnitLimit = parseIntOr(process.env.COMPUTE_UNIT_LIMIT, 1_400_000);
  const computeUnitPriceMicroLamports = parseIntOr(process.env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS, 0);

  const solanaRpcUrl = z.string().min(1).parse(process.env.SOLANA_RPC_URL);
  const walletSecretKey = z.string().min(1).parse(process.env.WALLET_SECRET_KEY);

  const configPath = process.env.CONFIG_PATH ?? './config.json';
  const pollIntervalMs = parseIntOr(process.env.POLL_INTERVAL_MS, 500);

  const jupSwapBaseUrl = process.env.JUP_SWAP_BASE_URL ?? 'https://api.jup.ag';
  const jupUltraBaseUrl = process.env.JUP_ULTRA_BASE_URL ?? 'https://api.jup.ag';
  const jupApiKey = process.env.JUP_API_KEY;
  const jupUseUltra = parseBoolean(process.env.JUP_USE_ULTRA, false);

  const useRustCalc = parseBoolean(process.env.USE_RUST_CALC, false);
  const rustCalcPath = process.env.RUST_CALC_PATH ?? './target/release/arb_calc';

  return {
    mode,
    executionStrategy,
    dryRunBuild,
    dryRunSimulate,
    logPath,
    baseFeeLamports,
    rentBufferLamports,
    computeUnitLimit,
    computeUnitPriceMicroLamports,
    solanaRpcUrl,
    walletSecretKey,
    configPath,
    pollIntervalMs,
    jupSwapBaseUrl,
    jupUltraBaseUrl,
    jupApiKey,
    jupUseUltra,
    useRustCalc,
    rustCalcPath,
  };
}

import { Connection, PublicKey } from '@solana/web3.js';

export type PriorityFeeStrategy = 'off' | 'rpc-recent' | 'helius';
export type PriorityFeeLevel = 'min' | 'low' | 'medium' | 'high' | 'veryHigh' | 'unsafeMax' | 'recommended';

export type PriorityFeeConfig = {
  strategy: PriorityFeeStrategy;
  level: PriorityFeeLevel;
  refreshMs: number;
  maxMicroLamports: number;
  heliusApiKey?: string;
  heliusRpcUrl?: string;
  targetAccountLimit: number;
};

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function uniqStrings(values: readonly string[]) {
  return Array.from(new Set(values));
}

function pickPercentile(values: number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const p = clampInt(percentile, 0, 100) / 100;
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

function levelToPercentile(level: PriorityFeeLevel): number {
  switch (level) {
    case 'min':
      return 0;
    case 'low':
      return 25;
    case 'medium':
      return 50;
    case 'high':
      return 75;
    case 'veryHigh':
      return 90;
    case 'unsafeMax':
      return 100;
    case 'recommended':
      return 50;
  }
}

function takeLockedWritableAccounts(keys: readonly string[], limit: number): PublicKey[] | undefined {
  const unique = uniqStrings(keys).slice(0, Math.max(0, Math.floor(limit)));
  const out: PublicKey[] = [];
  for (const k of unique) {
    try {
      out.push(new PublicKey(k));
    } catch {
      // ignore invalid pubkeys
    }
  }
  return out.length ? out : undefined;
}

async function estimateFromRpcRecent(params: {
  connection: Connection;
  level: PriorityFeeLevel;
  lockedWritableAccounts?: readonly string[];
  lockedWritableAccountLimit: number;
}) {
  const lockedWritableAccounts = takeLockedWritableAccounts(
    params.lockedWritableAccounts ?? [],
    params.lockedWritableAccountLimit,
  );

  const rows = await params.connection.getRecentPrioritizationFees(
    lockedWritableAccounts ? { lockedWritableAccounts } : undefined,
  );
  const fees = rows.map((r) => Number((r as any).prioritizationFee)).filter((n) => Number.isFinite(n) && n >= 0);
  return pickPercentile(fees, levelToPercentile(params.level));
}

type HeliusPriorityFeeLevels = Partial<Record<Exclude<PriorityFeeLevel, 'recommended'>, number>>;

function pickFromHeliusResponse(params: {
  level: PriorityFeeLevel;
  priorityFeeEstimate?: number;
  priorityFeeLevels?: HeliusPriorityFeeLevels;
}) {
  const estimate = params.priorityFeeEstimate;
  const levels = params.priorityFeeLevels;

  if (params.level === 'recommended') {
    if (typeof estimate === 'number' && Number.isFinite(estimate)) return estimate;
    const fallback = levels?.medium;
    return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0;
  }

  const candidate = levels?.[params.level] ?? estimate;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
}

function redactApiKey(url: URL) {
  const safe = new URL(url.toString());
  if (safe.searchParams.has('api-key')) safe.searchParams.set('api-key', 'REDACTED');
  return safe.toString();
}

async function fetchJsonRpcNoLeak<T>(url: URL, body: unknown): Promise<T> {
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${redactApiKey(url)}${text ? `: ${text}` : ''}`);
  }

  return (await res.json()) as T;
}

async function estimateFromHelius(params: {
  heliusRpcUrl: string;
  heliusApiKey: string;
  level: PriorityFeeLevel;
  accountKeys: readonly string[];
}) {
  const u = new URL(params.heliusRpcUrl);
  u.searchParams.set('api-key', params.heliusApiKey);

  const accountKeys = uniqStrings(params.accountKeys);
  const payload = {
    jsonrpc: '2.0',
    id: '1',
    method: 'getPriorityFeeEstimate',
    params: [
      {
        accountKeys: accountKeys.length ? accountKeys : undefined,
        options: {
          includeAllPriorityFeeLevels: true,
          recommended: true,
        },
      },
    ],
  };

  const json = await fetchJsonRpcNoLeak<{
    jsonrpc: '2.0';
    id: string;
    result?: { priorityFeeEstimate?: number; priorityFeeLevels?: HeliusPriorityFeeLevels };
    error?: { code?: number; message?: string };
  }>(u, payload);

  if (json.error) {
    throw new Error(`Helius getPriorityFeeEstimate error: ${json.error.message ?? 'unknown error'}`);
  }

  return pickFromHeliusResponse({
    level: params.level,
    priorityFeeEstimate: json.result?.priorityFeeEstimate,
    priorityFeeLevels: json.result?.priorityFeeLevels,
  });
}

export class PriorityFeeEstimator {
  private readonly config: PriorityFeeConfig;
  private lastFetchMs = 0;
  private cachedMicroLamports = 0;
  private hasCached = false;
  private inFlight?: Promise<number>;

  constructor(config: PriorityFeeConfig) {
    this.config = config;
  }

  async getMicroLamports(params: { connection: Connection; lockedWritableAccounts?: readonly string[] }): Promise<number> {
    if (this.config.strategy === 'off') return 0;

    const now = Date.now();
    if (now - this.lastFetchMs < this.config.refreshMs && this.hasCached) {
      return this.cachedMicroLamports;
    }

    if (this.inFlight) return await this.inFlight;

    const run = async () => {
      try {
        let estimate = 0;
        if (this.config.strategy === 'rpc-recent') {
          estimate = await estimateFromRpcRecent({
            connection: params.connection,
            level: this.config.level,
            lockedWritableAccounts: params.lockedWritableAccounts,
            lockedWritableAccountLimit: this.config.targetAccountLimit,
          });
        } else if (this.config.strategy === 'helius') {
          if (!this.config.heliusApiKey) return 0;
          try {
            estimate = await estimateFromHelius({
              heliusRpcUrl: this.config.heliusRpcUrl ?? 'https://mainnet.helius-rpc.com',
              heliusApiKey: this.config.heliusApiKey,
              level: this.config.level,
              accountKeys: params.lockedWritableAccounts ?? [],
            });
          } catch {
            // Fall back to standard Solana RPC method (works on QuickNode/Helius/etc).
            estimate = await estimateFromRpcRecent({
              connection: params.connection,
              level: this.config.level,
              lockedWritableAccounts: params.lockedWritableAccounts,
              lockedWritableAccountLimit: this.config.targetAccountLimit,
            });
          }
        }

        const microLamports = clampInt(estimate, 0, Math.max(0, this.config.maxMicroLamports));
        this.cachedMicroLamports = microLamports;
        this.lastFetchMs = Date.now();
        this.hasCached = true;
        return microLamports;
      } catch {
        // Keep last cached value if estimation fails.
        return this.cachedMicroLamports;
      } finally {
        this.inFlight = undefined;
      }
    };

    this.inFlight = run();
    return await this.inFlight;
  }
}

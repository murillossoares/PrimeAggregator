import type { Connection, Keypair } from '@solana/web3.js';

import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import { isHttp429, type ProviderCircuitBreaker } from '../lib/circuitBreaker.js';
import type { JupiterClient, QuoteResponse } from '../jupiter/types.js';
import type { OpenOceanClient } from '../openocean/client.js';
import type { OpenOceanQuote } from '../openocean/types.js';
import { decideWithOptionalRust } from './rustDecision.js';

export type LoopCandidate = {
  kind: 'loop';
  amountA: string;
  quote1: QuoteResponse;
  quote2: QuoteResponse;
  decision: { profitable: boolean; profit: string; conservativeProfit: string };
  feeEstimateLamports: string;
  feeEstimateInA?: string;
  jitoTipLamports: number;
};

export type OpenOceanLoopCandidate = {
  kind: 'loop_openocean';
  amountA: string;
  quote1: OpenOceanQuote;
  quote2: OpenOceanQuote;
  decision: { profitable: boolean; profit: string; conservativeProfit: string };
  feeEstimateLamports: string;
  feeEstimateInA?: string;
  jitoTipLamports: number;
};

export type TriangularCandidate = {
  kind: 'triangular';
  amountA: string;
  quote1: QuoteResponse;
  quote2: QuoteResponse;
  quote3: QuoteResponse;
  decision: { profitable: boolean; profit: string; conservativeProfit: string };
  feeEstimateLamports: string;
  feeEstimateInA?: string;
  jitoTipLamports: number;
};

export type Candidate = LoopCandidate | OpenOceanLoopCandidate | TriangularCandidate;

export type ScanSummary = {
  amountsTried: number;
  candidates: Candidate[];
  best?: Candidate;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  baseFeeLamports: number;
  rentBufferLamports: number;
  jupiterQuoteCalls: number;
  openOceanQuoteCalls: number;
  feeConversionQuoteCalls: number;
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function toBigInt(s: string) {
  return BigInt(s);
}

function uniqStrings(values: string[]) {
  return Array.from(new Set(values));
}

function normalizeAmountList(values: string[]) {
  return uniqStrings(values.filter((v) => /^\d+$/.test(v)));
}

function parseAmountList(pair: BotPair, override?: string[]): string[] {
  const normalizedOverride = override?.length ? normalizeAmountList(override) : [];
  if (normalizedOverride.length) return normalizedOverride;

  const steps = pair.amountASteps?.length ? pair.amountASteps : [pair.amountA];
  return normalizeAmountList(steps);
}

function estimateFeeLamports(params: {
  baseFeeLamports: number;
  rentBufferLamports: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  jitoTipLamports: number;
  txCount?: number;
  signaturesPerTx?: number;
}): string {
  const txCount = BigInt(Math.max(1, Math.floor(params.txCount ?? 1)));
  const signaturesPerTx = BigInt(Math.max(1, Math.floor(params.signaturesPerTx ?? 1)));

  const base = BigInt(params.baseFeeLamports) * txCount * signaturesPerTx;
  const rent = BigInt(params.rentBufferLamports) * txCount;
  const priority =
    params.computeUnitPriceMicroLamports > 0
      ? (BigInt(params.computeUnitLimit) * BigInt(params.computeUnitPriceMicroLamports)) / 1_000_000n
      : 0n;
  const tip = BigInt(params.jitoTipLamports);
  return (base + rent + priority * txCount + tip).toString();
}

function computeMinProfitA(params: { amountA: string; minProfitA: string; minProfitBps?: number }): string {
  const minProfitAbs = BigInt(params.minProfitA);
  const bps = params.minProfitBps;
  if (bps === undefined || bps <= 0) return minProfitAbs.toString();

  const amountA = BigInt(params.amountA);
  if (amountA <= 0n) return minProfitAbs.toString();

  const minProfitPct = (amountA * BigInt(Math.floor(bps))) / 10_000n;
  return (minProfitPct > minProfitAbs ? minProfitPct : minProfitAbs).toString();
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
    if (currentProfit > bestProfit) best = candidate;
  }
  return best;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function computeJitoTipLamports(params: {
  jitoEnabled: boolean;
  jitoTipMode: 'fixed' | 'dynamic';
  fixedTipLamports: number;
  minTipLamports: number;
  maxTipLamports: number;
  tipBps: number;
  pair: BotPair;
  amountA: string;
  finalMinOut: string;
}): number {
  if (!params.jitoEnabled) return 0;
  if (params.fixedTipLamports <= 0 && params.jitoTipMode === 'fixed') return 0;

  if (params.jitoTipMode === 'fixed') return Math.max(0, Math.floor(params.fixedTipLamports));

  // Dynamic tip is only safe to reason about for SOL-based loops, because the tip is paid in SOL.
  if (params.pair.aMint !== SOL_MINT) return Math.max(0, Math.floor(params.fixedTipLamports));

  const gross = BigInt(params.finalMinOut) - BigInt(params.amountA);
  if (gross <= 0n) return 0;

  const raw = (gross * BigInt(params.tipBps)) / 10_000n;
  const maxAllowed = BigInt(Math.max(0, Math.floor(params.maxTipLamports)));
  const minAllowed = BigInt(Math.max(0, Math.floor(params.minTipLamports)));
  const clamped = raw < minAllowed ? minAllowed : raw > maxAllowed ? maxAllowed : raw;

  const asNumber = Number(clamped);
  if (!Number.isFinite(asNumber)) return Math.max(0, Math.floor(params.fixedTipLamports));
  return clampNumber(asNumber, 0, Math.max(0, Math.floor(params.maxTipLamports)));
}

function decidePathInTs(params: {
  amountIn: string;
  finalOut: string;
  finalMinOut: string;
  minProfit: string;
  feeEstimateInA: string;
}) {
  const amountIn = BigInt(params.amountIn);
  const out = BigInt(params.finalOut);
  const outMin = BigInt(params.finalMinOut);
  const minProfit = BigInt(params.minProfit);
  const feeEstimate = BigInt(params.feeEstimateInA);

  const profit = out - amountIn - feeEstimate;
  const conservativeProfit = outMin - amountIn - feeEstimate;

  return {
    profitable: conservativeProfit >= minProfit,
    profit: profit.toString(),
    conservativeProfit: conservativeProfit.toString(),
  };
}

type FeeConversionCacheEntry = { expiresAt: number; value: Promise<string> };
const feeConversionCache = new Map<string, FeeConversionCacheEntry>();

function ceilDiv(n: bigint, d: bigint) {
  if (d <= 0n) throw new Error('ceilDiv requires d>0');
  if (n <= 0n) return 0n;
  return (n + d - 1n) / d;
}

async function convertFeeLamportsToAAtomic(params: {
  quoteJupiter: Extract<JupiterClient, { kind: 'swap-v1' } | { kind: 'v6' }>;
  pairKey: string;
  aMint: string;
  feeLamports: string;
  slippageBps: number;
  cacheTtlMs: number;
}): Promise<string> {
  if (!/^\d+$/.test(params.feeLamports)) return '0';
  if (params.feeLamports === '0') return '0';
  if (params.aMint === SOL_MINT) return params.feeLamports;

  const slippageBps = Math.max(1, Math.min(5000, Math.floor(params.slippageBps)));
  const cacheTtlMs = Math.max(10_000, Math.floor(params.cacheTtlMs));
  const key = `${params.pairKey}:${params.aMint}:${slippageBps}:${params.quoteJupiter.kind}`;
  const now = Date.now();
  const hit = feeConversionCache.get(key);
  if (hit && hit.expiresAt > now) return await hit.value;

  // Cache SOL->A conversion as "outAmount for 1 SOL" and convert fee lamports via a ratio.
  // Use outAmount (optimistic execution) as a conservative cost estimate (higher A-per-SOL => higher cost).
  const oneSolLamports = 1_000_000_000n;
  const value = params.quoteJupiter
    .quoteExactIn({
      inputMint: SOL_MINT,
      outputMint: params.aMint,
      amount: oneSolLamports.toString(),
      slippageBps,
    })
    .then((q) => {
      const outPerSol = BigInt(q.outAmount);
      const feeLamports = BigInt(params.feeLamports);
      const feeInA = ceilDiv(feeLamports * outPerSol, oneSolLamports);
      return feeInA.toString();
    });

  feeConversionCache.set(key, { expiresAt: now + cacheTtlMs, value });
  try {
    return await value;
  } catch (e) {
    feeConversionCache.delete(key);
    throw e;
  }
}

export async function scanPair(params: {
  connection: Connection;
  wallet: Keypair;
  quoteJupiter: Extract<JupiterClient, { kind: 'swap-v1' } | { kind: 'v6' }>;
  openOcean?: OpenOceanClient;
  providerCircuitBreaker?: ProviderCircuitBreaker;
  jup429CooldownMs?: number;
  openOcean429CooldownMs?: number;
  amountsOverride?: string[];
  enableOpenOcean?: boolean;
  openOceanJupiterGateBps?: number;
  openOceanJupiterNearGateBps?: number;
  openOceanSignaturesEstimate?: number;
  executionStrategy: 'atomic' | 'sequential';
  pair: BotPair;
  logEvent: Logger;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  baseFeeLamports: number;
  rentBufferLamports: number;
  feeConversionCacheTtlMs?: number;
  jitoEnabled: boolean;
  jitoTipLamports: number;
  jitoTipMode: 'fixed' | 'dynamic';
  jitoMinTipLamports: number;
  jitoMaxTipLamports: number;
  jitoTipBps: number;
  useRustCalc: boolean;
  rustCalcPath: string;
}): Promise<ScanSummary> {
  const amounts = parseAmountList(params.pair, params.amountsOverride);
  const breaker = params.providerCircuitBreaker;
  const jupiterBreakerKey = `jupiter:${params.pair.name}`;
  const openOceanBreakerKey = `openocean:${params.pair.name}`;
  const jup429CooldownMs = Math.max(0, Math.floor(params.jup429CooldownMs ?? 30_000));
  const openOcean429CooldownMs = Math.max(0, Math.floor(params.openOcean429CooldownMs ?? 60_000));

  let jupiterQuoteCalls = 0;
  let openOceanQuoteCalls = 0;
  let feeConversionQuoteCalls = 0;

  const jupQuote = async (p: Parameters<typeof params.quoteJupiter.quoteExactIn>[0]) => {
    jupiterQuoteCalls += 1;
    return await params.quoteJupiter.quoteExactIn(p);
  };
  const ooQuote = async (p: Parameters<OpenOceanClient['quoteExactIn']>[0]) => {
    openOceanQuoteCalls += 1;
    return await (params.openOcean as OpenOceanClient).quoteExactIn(p);
  };

  const computeUnitLimit = params.pair.computeUnitLimit ?? params.computeUnitLimit;
  const computeUnitPriceMicroLamports =
    params.pair.computeUnitPriceMicroLamports ?? params.computeUnitPriceMicroLamports;
  const baseFeeLamports = params.pair.baseFeeLamports ?? params.baseFeeLamports;
  const rentBufferLamports = params.pair.rentBufferLamports ?? params.rentBufferLamports;
  const openOceanSignaturesEstimate = Math.max(1, Math.floor(params.openOceanSignaturesEstimate ?? 3));
  const slippageBpsLeg1 = params.pair.slippageBpsLeg1 ?? params.pair.slippageBps;
  const slippageBpsLeg2 = params.pair.slippageBpsLeg2 ?? params.pair.slippageBps;
  const slippageBpsLeg3 = params.pair.slippageBpsLeg3 ?? params.pair.slippageBps;
  const feeConversionCacheTtlMs = Math.max(
    10_000,
    Math.floor(Math.max(params.feeConversionCacheTtlMs ?? 60_000, params.pair.cooldownMs ?? 0)),
  );

  const includeDexes = params.pair.includeDexes;
  const excludeDexes = params.pair.excludeDexes;

  if (breaker?.isOpen(jupiterBreakerKey)) {
    await params.logEvent({
      ts: new Date().toISOString(),
      type: 'skip',
      pair: params.pair.name,
      provider: 'jupiter',
      reason: 'rate-limited',
      cooldownMsRemaining: breaker.remainingMs(jupiterBreakerKey),
    });
    return {
      amountsTried: 0,
      candidates: [],
      best: undefined,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
      baseFeeLamports,
      rentBufferLamports,
      jupiterQuoteCalls,
      openOceanQuoteCalls,
      feeConversionQuoteCalls,
    };
  }

  if (params.pair.cMint) {
    const candidates: Candidate[] = [];
    for (const amountA of amounts) {
      if (params.pair.maxNotionalA && toBigInt(amountA) > toBigInt(params.pair.maxNotionalA)) {
        continue;
      }
      if (breaker?.isOpen(jupiterBreakerKey)) break;

      try {
        const quote1 = await jupQuote({
          inputMint: params.pair.aMint,
          outputMint: params.pair.bMint,
          amount: amountA,
          slippageBps: slippageBpsLeg1,
          includeDexes,
          excludeDexes,
        });

        const quote2 = await jupQuote({
          inputMint: params.pair.bMint,
          outputMint: params.pair.cMint,
          amount: quote1.otherAmountThreshold,
          slippageBps: slippageBpsLeg2,
          includeDexes,
          excludeDexes,
        });

        const quote3 = await jupQuote({
          inputMint: params.pair.cMint,
          outputMint: params.pair.aMint,
          amount: quote2.otherAmountThreshold,
          slippageBps: slippageBpsLeg3,
          includeDexes,
          excludeDexes,
        });

        const jitoTipLamports = computeJitoTipLamports({
          jitoEnabled: params.jitoEnabled,
          jitoTipMode: params.jitoTipMode,
          fixedTipLamports: params.jitoTipLamports,
          minTipLamports: params.jitoMinTipLamports,
          maxTipLamports: params.jitoMaxTipLamports,
          tipBps: params.jitoTipBps,
          pair: params.pair,
          amountA,
          finalMinOut: quote3.otherAmountThreshold,
        });

        const feeEstimateLamports = estimateFeeLamports({
          baseFeeLamports,
          rentBufferLamports,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          jitoTipLamports,
          txCount: 1,
          signaturesPerTx: 1,
        });

        feeConversionQuoteCalls += 1;
        const feeEstimateInA = await convertFeeLamportsToAAtomic({
          quoteJupiter: params.quoteJupiter,
          pairKey: params.pair.name,
          aMint: params.pair.aMint,
          feeLamports: feeEstimateLamports,
          slippageBps: params.pair.slippageBps,
          cacheTtlMs: feeConversionCacheTtlMs,
        });

        const minProfitA = computeMinProfitA({
          amountA,
          minProfitA: params.pair.minProfitA,
          minProfitBps: params.pair.minProfitBps,
        });
        const decision = decidePathInTs({
          amountIn: amountA,
          finalOut: quote3.outAmount,
          finalMinOut: quote3.otherAmountThreshold,
          minProfit: minProfitA,
          feeEstimateInA,
        });

        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'candidate',
          pair: params.pair.name,
          triangular: true,
          amountA,
          includeDexes,
          excludeDexes,
          slippageBps: params.pair.slippageBps,
          slippageBpsLeg1,
          slippageBpsLeg2,
          slippageBpsLeg3,
          outB: quote1.outAmount,
          outBMin: quote1.otherAmountThreshold,
          outC: quote2.outAmount,
          outCMin: quote2.otherAmountThreshold,
          outA: quote3.outAmount,
          outAMin: quote3.otherAmountThreshold,
          feeEstimateLamports,
          feeEstimateInA: params.pair.aMint === SOL_MINT ? undefined : feeEstimateInA,
          jitoTipLamports,
          profit: decision.profit,
          conservativeProfit: decision.conservativeProfit,
          profitable: decision.profitable,
        });

        candidates.push({
          kind: 'triangular',
          amountA,
          quote1,
          quote2,
          quote3,
          decision,
          feeEstimateLamports,
          feeEstimateInA: params.pair.aMint === SOL_MINT ? undefined : feeEstimateInA,
          jitoTipLamports,
        });
      } catch (error) {
        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'candidate_error',
          pair: params.pair.name,
          triangular: true,
          amountA,
          error: String(error),
        });

        if (breaker && isHttp429(error)) {
          await params.logEvent({
            ts: new Date().toISOString(),
            type: 'rate_limit',
            pair: params.pair.name,
            provider: 'jupiter',
            status: 429,
            where: 'quote',
          });
          breaker.open(jupiterBreakerKey, jup429CooldownMs);
          break;
        }
      }
    }

    return {
      amountsTried: amounts.length,
      candidates,
      best: pickBestCandidate(candidates),
      computeUnitLimit,
      computeUnitPriceMicroLamports,
      baseFeeLamports,
      rentBufferLamports,
      jupiterQuoteCalls,
      openOceanQuoteCalls,
      feeConversionQuoteCalls,
    };
  }

  const candidates: Candidate[] = [];

  const enableOpenOcean = params.enableOpenOcean ?? true;
  const canUseOpenOcean = enableOpenOcean && params.executionStrategy === 'sequential' && Boolean(params.openOcean);

  for (const amountA of amounts) {
    if (params.pair.maxNotionalA && toBigInt(amountA) > toBigInt(params.pair.maxNotionalA)) {
      continue;
    }
    if (breaker?.isOpen(jupiterBreakerKey)) break;

      try {
        const quote1 = await jupQuote({
          inputMint: params.pair.aMint,
          outputMint: params.pair.bMint,
          amount: amountA,
          slippageBps: slippageBpsLeg1,
          includeDexes,
          excludeDexes,
        });

        const quote1OutMin = quote1.otherAmountThreshold;
        const quote2 = await jupQuote({
          inputMint: params.pair.bMint,
          outputMint: params.pair.aMint,
          amount: quote1OutMin,
          slippageBps: slippageBpsLeg2,
          includeDexes,
          excludeDexes,
        });

      const jitoTipLamports = computeJitoTipLamports({
        jitoEnabled: params.jitoEnabled,
        jitoTipMode: params.jitoTipMode,
        fixedTipLamports: params.jitoTipLamports,
        minTipLamports: params.jitoMinTipLamports,
        maxTipLamports: params.jitoMaxTipLamports,
        tipBps: params.jitoTipBps,
        pair: params.pair,
        amountA,
        finalMinOut: quote2.otherAmountThreshold,
      });

      const feeEstimateLamports = estimateFeeLamports({
        baseFeeLamports,
        rentBufferLamports,
        computeUnitLimit,
        computeUnitPriceMicroLamports,
        jitoTipLamports,
        txCount: params.executionStrategy === 'sequential' ? 2 : 1,
        signaturesPerTx: 1,
      });

      feeConversionQuoteCalls += 1;
      const feeEstimateInA = await convertFeeLamportsToAAtomic({
        quoteJupiter: params.quoteJupiter,
        pairKey: params.pair.name,
        aMint: params.pair.aMint,
        feeLamports: feeEstimateLamports,
        slippageBps: params.pair.slippageBps,
        cacheTtlMs: feeConversionCacheTtlMs,
      });

      const decision = await decideWithOptionalRust({
        useRust: params.useRustCalc,
        rustCalcPath: params.rustCalcPath,
        amountIn: amountA,
        quote1Out: quote1.outAmount,
        quote1MinOut: quote1.otherAmountThreshold,
        quote2Out: quote2.outAmount,
        quote2MinOut: quote2.otherAmountThreshold,
        minProfit: computeMinProfitA({
          amountA,
          minProfitA: params.pair.minProfitA,
          minProfitBps: params.pair.minProfitBps,
        }),
        feeEstimateInInputUnits: feeEstimateInA,
      });

      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'candidate',
        pair: params.pair.name,
        provider: 'jupiter',
        amountA,
        includeDexes,
        excludeDexes,
        slippageBps: params.pair.slippageBps,
        slippageBpsLeg1,
        slippageBpsLeg2,
        feeEstimateLamports,
        feeEstimateInA: params.pair.aMint === SOL_MINT ? undefined : feeEstimateInA,
        jitoTipLamports,
        profit: decision.profit,
        conservativeProfit: decision.conservativeProfit,
        profitable: decision.profitable,
      });

      candidates.push({
        kind: 'loop',
        amountA,
        quote1,
        quote2,
        decision,
        feeEstimateLamports,
        feeEstimateInA: params.pair.aMint === SOL_MINT ? undefined : feeEstimateInA,
        jitoTipLamports,
      });
    } catch (error) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'candidate_error',
        pair: params.pair.name,
        provider: 'jupiter',
        amountA,
        error: String(error),
      });

      if (breaker && isHttp429(error)) {
        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'rate_limit',
          pair: params.pair.name,
          provider: 'jupiter',
          status: 429,
          where: 'quote',
        });
        breaker.open(jupiterBreakerKey, jup429CooldownMs);
        break;
      }
    }
  }

  if (canUseOpenOcean) {
    if (breaker?.isOpen(openOceanBreakerKey)) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'openocean_skip',
        pair: params.pair.name,
        reason: 'rate-limited',
        cooldownMsRemaining: breaker.remainingMs(openOceanBreakerKey),
      });
      return {
        amountsTried: amounts.length,
        candidates,
        best: pickBestCandidate(candidates),
        computeUnitLimit,
        computeUnitPriceMicroLamports,
        baseFeeLamports,
        rentBufferLamports,
        jupiterQuoteCalls,
        openOceanQuoteCalls,
        feeConversionQuoteCalls,
      };
    }

    const bestJupiter = pickBestCandidate(candidates);
    if (!bestJupiter) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'openocean_skip',
        pair: params.pair.name,
        reason: 'no_jupiter_candidate',
      });
      return {
        amountsTried: amounts.length,
        candidates,
        best: pickBestCandidate(candidates),
        computeUnitLimit,
        computeUnitPriceMicroLamports,
        baseFeeLamports,
        rentBufferLamports,
        jupiterQuoteCalls,
        openOceanQuoteCalls,
        feeConversionQuoteCalls,
      };
    }

    const gateBps = params.openOceanJupiterGateBps;
    const nearGateBps = params.openOceanJupiterNearGateBps;
    if (gateBps !== undefined) {
      try {
        const profit = BigInt(bestJupiter.decision.conservativeProfit);
        const amountA = BigInt(bestJupiter.amountA);
        const bps = amountA > 0n ? Number((profit * 10_000n) / amountA) : undefined;
        if (bps !== undefined && Number.isFinite(bps) && bps < gateBps) {
          await params.logEvent({
            ts: new Date().toISOString(),
            type: 'openocean_skip',
            pair: params.pair.name,
            reason: 'jupiter_gate',
            jupiterBps: bps,
            gateBps,
            amountA: bestJupiter.amountA,
          });
          return {
            amountsTried: amounts.length,
            candidates,
            best: pickBestCandidate(candidates),
            computeUnitLimit,
            computeUnitPriceMicroLamports,
            baseFeeLamports,
            rentBufferLamports,
            jupiterQuoteCalls,
            openOceanQuoteCalls,
            feeConversionQuoteCalls,
          };
        }
        if (
          nearGateBps !== undefined &&
          Number.isFinite(nearGateBps) &&
          Math.floor(nearGateBps) > 0 &&
          bps !== undefined &&
          Number.isFinite(bps) &&
          bps > gateBps + Math.floor(nearGateBps)
        ) {
          await params.logEvent({
            ts: new Date().toISOString(),
            type: 'openocean_skip',
            pair: params.pair.name,
            reason: 'jupiter_not_near_gate',
            jupiterBps: bps,
            gateBps,
            nearGateBps: Math.floor(nearGateBps),
            amountA: bestJupiter.amountA,
          });
          return {
            amountsTried: amounts.length,
            candidates,
            best: pickBestCandidate(candidates),
            computeUnitLimit,
            computeUnitPriceMicroLamports,
            baseFeeLamports,
            rentBufferLamports,
            jupiterQuoteCalls,
            openOceanQuoteCalls,
            feeConversionQuoteCalls,
          };
        }
      } catch {
        // ignore gate parse errors
      }
    }

    const referenceAmountA = bestJupiter.amountA ?? amounts[0];

    try {
      const openOcean = params.openOcean as OpenOceanClient;

      const quote1 = await ooQuote({
        inputMint: params.pair.aMint,
        outputMint: params.pair.bMint,
        amountAtomic: referenceAmountA,
        slippageBps: slippageBpsLeg1,
      });

      const quote2 = await ooQuote({
        inputMint: params.pair.bMint,
        outputMint: params.pair.aMint,
        amountAtomic: quote1.otherAmountThreshold,
        slippageBps: slippageBpsLeg2,
      });

      const jitoTipLamports = computeJitoTipLamports({
        jitoEnabled: params.jitoEnabled,
        jitoTipMode: params.jitoTipMode,
        fixedTipLamports: params.jitoTipLamports,
        minTipLamports: params.jitoMinTipLamports,
        maxTipLamports: params.jitoMaxTipLamports,
        tipBps: params.jitoTipBps,
        pair: params.pair,
        amountA: referenceAmountA,
        finalMinOut: quote2.otherAmountThreshold,
      });

      const feeEstimateLamports = estimateFeeLamports({
        baseFeeLamports,
        rentBufferLamports,
        computeUnitLimit,
        computeUnitPriceMicroLamports,
        jitoTipLamports,
        txCount: 2,
        signaturesPerTx: openOceanSignaturesEstimate,
      });

      feeConversionQuoteCalls += 1;
      const feeEstimateInA = await convertFeeLamportsToAAtomic({
        quoteJupiter: params.quoteJupiter,
        pairKey: params.pair.name,
        aMint: params.pair.aMint,
        feeLamports: feeEstimateLamports,
        slippageBps: params.pair.slippageBps,
        cacheTtlMs: feeConversionCacheTtlMs,
      });

      const decision = await decideWithOptionalRust({
        useRust: params.useRustCalc,
        rustCalcPath: params.rustCalcPath,
        amountIn: referenceAmountA,
        quote1Out: quote1.outAmount,
        quote1MinOut: quote1.otherAmountThreshold,
        quote2Out: quote2.outAmount,
        quote2MinOut: quote2.otherAmountThreshold,
        minProfit: computeMinProfitA({
          amountA: referenceAmountA,
          minProfitA: params.pair.minProfitA,
          minProfitBps: params.pair.minProfitBps,
        }),
        feeEstimateInInputUnits: feeEstimateInA,
      });

      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'candidate',
        pair: params.pair.name,
        provider: 'openocean',
        amountA: referenceAmountA,
        slippageBps: params.pair.slippageBps,
        slippageBpsLeg1,
        slippageBpsLeg2,
        outB: quote1.outAmount,
        outBMin: quote1.otherAmountThreshold,
        outA: quote2.outAmount,
        outAMin: quote2.otherAmountThreshold,
        dexId1: quote1.dexId,
        dexId2: quote2.dexId,
        feeEstimateLamports,
        feeEstimateInA: params.pair.aMint === SOL_MINT ? undefined : feeEstimateInA,
        jitoTipLamports,
        profit: decision.profit,
        conservativeProfit: decision.conservativeProfit,
        profitable: decision.profitable,
      });

      candidates.push({
        kind: 'loop_openocean',
        amountA: referenceAmountA,
        quote1,
        quote2,
        decision,
        feeEstimateLamports,
        feeEstimateInA: params.pair.aMint === SOL_MINT ? undefined : feeEstimateInA,
        jitoTipLamports,
      });
    } catch (error) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'candidate_error',
        pair: params.pair.name,
        provider: 'openocean',
        amountA: referenceAmountA,
        error: String(error),
      });

      if (breaker && isHttp429(error)) {
        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'rate_limit',
          pair: params.pair.name,
          provider: 'openocean',
          status: 429,
          where: 'quote',
        });
        breaker.open(openOceanBreakerKey, openOcean429CooldownMs);
      }
    }
  }

  return {
    amountsTried: amounts.length,
    candidates,
    best: pickBestCandidate(candidates),
    computeUnitLimit,
    computeUnitPriceMicroLamports,
    baseFeeLamports,
    rentBufferLamports,
    jupiterQuoteCalls,
    openOceanQuoteCalls,
    feeConversionQuoteCalls,
  };
}

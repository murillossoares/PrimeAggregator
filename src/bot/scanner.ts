import type { Connection, Keypair } from '@solana/web3.js';

import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { JupiterClient, QuoteResponse, UltraOrderResponse } from '../jupiter/types.js';
import type { OpenOceanClient } from '../openocean/client.js';
import type { OpenOceanQuote } from '../openocean/types.js';
import { decideWithOptionalRust } from './rustDecision.js';

export type LoopCandidate = {
  kind: 'loop';
  amountA: string;
  quote1: QuoteResponse | UltraOrderResponse;
  quote2: QuoteResponse | UltraOrderResponse;
  decision: { profitable: boolean; profit: string; conservativeProfit: string };
  feeEstimateLamports: string;
  jitoTipLamports: number;
};

export type OpenOceanLoopCandidate = {
  kind: 'loop_openocean';
  amountA: string;
  quote1: OpenOceanQuote;
  quote2: OpenOceanQuote;
  decision: { profitable: boolean; profit: string; conservativeProfit: string };
  feeEstimateLamports: string;
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
  feeEstimateLamports: string;
}) {
  const amountIn = BigInt(params.amountIn);
  const out = BigInt(params.finalOut);
  const outMin = BigInt(params.finalMinOut);
  const minProfit = BigInt(params.minProfit);
  const feeEstimate = BigInt(params.feeEstimateLamports);

  const profit = out - amountIn - feeEstimate;
  const conservativeProfit = outMin - amountIn - feeEstimate;

  return {
    profitable: conservativeProfit >= minProfit,
    profit: profit.toString(),
    conservativeProfit: conservativeProfit.toString(),
  };
}

export async function scanPair(params: {
  connection: Connection;
  wallet: Keypair;
  jupiter: JupiterClient;
  openOcean?: OpenOceanClient;
  amountsOverride?: string[];
  enableOpenOcean?: boolean;
  openOceanJupiterGateBps?: number;
  openOceanSignaturesEstimate?: number;
  executionStrategy: 'atomic' | 'sequential';
  pair: BotPair;
  logEvent: Logger;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  baseFeeLamports: number;
  rentBufferLamports: number;
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
  const computeUnitLimit = params.pair.computeUnitLimit ?? params.computeUnitLimit;
  const computeUnitPriceMicroLamports =
    params.pair.computeUnitPriceMicroLamports ?? params.computeUnitPriceMicroLamports;
  const baseFeeLamports = params.pair.baseFeeLamports ?? params.baseFeeLamports;
  const rentBufferLamports = params.pair.rentBufferLamports ?? params.rentBufferLamports;
  const openOceanSignaturesEstimate = Math.max(1, Math.floor(params.openOceanSignaturesEstimate ?? 3));
  const slippageBpsLeg1 = params.pair.slippageBpsLeg1 ?? params.pair.slippageBps;
  const slippageBpsLeg2 = params.pair.slippageBpsLeg2 ?? params.pair.slippageBps;
  const slippageBpsLeg3 = params.pair.slippageBpsLeg3 ?? params.pair.slippageBps;

  const includeDexes = params.pair.includeDexes;
  const excludeDexes = params.pair.excludeDexes;

  if (params.pair.cMint) {
    if (params.jupiter.kind === 'ultra') {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'skip',
        pair: params.pair.name,
        reason: 'triangular-requires-quote-api',
      });
      return {
        amountsTried: amounts.length,
        candidates: [],
        best: undefined,
        computeUnitLimit,
        computeUnitPriceMicroLamports,
        baseFeeLamports,
        rentBufferLamports,
      };
    }

    const candidates: Candidate[] = [];
    for (const amountA of amounts) {
      if (params.pair.maxNotionalA && toBigInt(amountA) > toBigInt(params.pair.maxNotionalA)) {
        continue;
      }

      try {
        const quote1 = await params.jupiter.quoteExactIn({
          inputMint: params.pair.aMint,
          outputMint: params.pair.bMint,
          amount: amountA,
          slippageBps: slippageBpsLeg1,
          includeDexes,
          excludeDexes,
        });

        const quote2 = await params.jupiter.quoteExactIn({
          inputMint: params.pair.bMint,
          outputMint: params.pair.cMint,
          amount: quote1.otherAmountThreshold,
          slippageBps: slippageBpsLeg2,
          includeDexes,
          excludeDexes,
        });

        const quote3 = await params.jupiter.quoteExactIn({
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
          feeEstimateLamports,
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
          jitoTipLamports,
          profit: decision.profit,
          conservativeProfit: decision.conservativeProfit,
          profitable: decision.profitable,
        });

        candidates.push({ kind: 'triangular', amountA, quote1, quote2, quote3, decision, feeEstimateLamports, jitoTipLamports });
      } catch (error) {
        await params.logEvent({
          ts: new Date().toISOString(),
          type: 'candidate_error',
          pair: params.pair.name,
          triangular: true,
          amountA,
          error: String(error),
        });
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
    };
  }

  const candidates: Candidate[] = [];

  const enableOpenOcean = params.enableOpenOcean ?? true;
  const canUseOpenOcean = enableOpenOcean && params.executionStrategy === 'sequential' && Boolean(params.openOcean);

  for (const amountA of amounts) {
    if (params.pair.maxNotionalA && toBigInt(amountA) > toBigInt(params.pair.maxNotionalA)) {
      continue;
    }

      try {
        const quote1: QuoteResponse | UltraOrderResponse =
          params.jupiter.kind === 'ultra'
            ? await params.jupiter.order({
                inputMint: params.pair.aMint,
                outputMint: params.pair.bMint,
                amount: amountA,
                taker: params.wallet.publicKey.toBase58(),
              })
            : await params.jupiter.quoteExactIn({
                inputMint: params.pair.aMint,
                outputMint: params.pair.bMint,
                amount: amountA,
                slippageBps: slippageBpsLeg1,
                includeDexes,
                excludeDexes,
              });

        const quote1OutMin = quote1.otherAmountThreshold;
        const quote2: QuoteResponse | UltraOrderResponse =
          params.jupiter.kind === 'ultra'
            ? await params.jupiter.order({
                inputMint: params.pair.bMint,
                outputMint: params.pair.aMint,
                amount: quote1OutMin,
                taker: params.wallet.publicKey.toBase58(),
              })
            : await params.jupiter.quoteExactIn({
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
        txCount: params.jupiter.kind === 'ultra' || params.executionStrategy === 'sequential' ? 2 : 1,
        signaturesPerTx: 1,
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
        feeEstimateLamports,
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
        jitoTipLamports,
        profit: decision.profit,
        conservativeProfit: decision.conservativeProfit,
        profitable: decision.profitable,
      });

      candidates.push({ kind: 'loop', amountA, quote1, quote2, decision, feeEstimateLamports, jitoTipLamports });
    } catch (error) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'candidate_error',
        pair: params.pair.name,
        provider: 'jupiter',
        amountA,
        error: String(error),
      });
    }
  }

  if (canUseOpenOcean) {
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
      };
    }

    const gateBps = params.openOceanJupiterGateBps;
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
          };
        }
      } catch {
        // ignore gate parse errors
      }
    }

    const referenceAmountA = bestJupiter.amountA ?? amounts[0];

    try {
      const openOcean = params.openOcean as OpenOceanClient;

      const quote1 = await openOcean.quoteExactIn({
        inputMint: params.pair.aMint,
        outputMint: params.pair.bMint,
        amountAtomic: referenceAmountA,
        slippageBps: slippageBpsLeg1,
      });

      const quote2 = await openOcean.quoteExactIn({
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
        feeEstimateLamports,
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
  };
}

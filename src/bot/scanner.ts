import type { Connection, Keypair } from '@solana/web3.js';

import type { BotPair } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { JupiterClient, QuoteResponse, UltraOrderResponse } from '../jupiter/types.js';
import { decideWithOptionalRust } from './rustDecision.js';

export type Candidate = {
  amountA: string;
  quote1: QuoteResponse | UltraOrderResponse;
  quote2: QuoteResponse | UltraOrderResponse;
  decision: { profitable: boolean; profit: string; conservativeProfit: string };
  feeEstimateLamports: string;
  jitoTipLamports: number;
};

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

function parseAmountList(pair: BotPair): string[] {
  const steps = pair.amountASteps?.length ? pair.amountASteps : [pair.amountA];
  return uniqStrings(steps.filter((v) => /^\d+$/.test(v)));
}

function estimateFeeLamports(params: {
  baseFeeLamports: number;
  rentBufferLamports: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  jitoTipLamports: number;
}): string {
  const base = BigInt(params.baseFeeLamports);
  const rent = BigInt(params.rentBufferLamports);
  const priority =
    params.computeUnitPriceMicroLamports > 0
      ? (BigInt(params.computeUnitLimit) * BigInt(params.computeUnitPriceMicroLamports)) / 1_000_000n
      : 0n;
  const tip = BigInt(params.jitoTipLamports);
  return (base + rent + priority + tip).toString();
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
  quote2MinOut: string;
}): number {
  if (!params.jitoEnabled) return 0;
  if (params.fixedTipLamports <= 0 && params.jitoTipMode === 'fixed') return 0;

  if (params.jitoTipMode === 'fixed') return Math.max(0, Math.floor(params.fixedTipLamports));

  // Dynamic tip is only safe to reason about for SOL-based loops, because the tip is paid in SOL.
  if (params.pair.aMint !== SOL_MINT) return Math.max(0, Math.floor(params.fixedTipLamports));

  const gross = BigInt(params.quote2MinOut) - BigInt(params.amountA);
  if (gross <= 0n) return 0;

  const raw = (gross * BigInt(params.tipBps)) / 10_000n;
  const maxAllowed = BigInt(Math.max(0, Math.floor(params.maxTipLamports)));
  const minAllowed = BigInt(Math.max(0, Math.floor(params.minTipLamports)));
  const clamped = raw < minAllowed ? minAllowed : raw > maxAllowed ? maxAllowed : raw;

  const asNumber = Number(clamped);
  if (!Number.isFinite(asNumber)) return Math.max(0, Math.floor(params.fixedTipLamports));
  return clampNumber(asNumber, 0, Math.max(0, Math.floor(params.maxTipLamports)));
}

export async function scanPair(params: {
  connection: Connection;
  wallet: Keypair;
  jupiter: JupiterClient;
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
  const amounts = parseAmountList(params.pair);
  const computeUnitLimit = params.pair.computeUnitLimit ?? params.computeUnitLimit;
  const computeUnitPriceMicroLamports =
    params.pair.computeUnitPriceMicroLamports ?? params.computeUnitPriceMicroLamports;
  const baseFeeLamports = params.pair.baseFeeLamports ?? params.baseFeeLamports;
  const rentBufferLamports = params.pair.rentBufferLamports ?? params.rentBufferLamports;

  const candidates: Candidate[] = [];
  for (const amountA of amounts) {
    if (params.pair.maxNotionalA && toBigInt(amountA) > toBigInt(params.pair.maxNotionalA)) {
      continue;
    }

    try {
      const quote1: QuoteResponse | UltraOrderResponse =
        params.jupiter.kind === 'swap-v1'
          ? await params.jupiter.quoteExactIn({
              inputMint: params.pair.aMint,
              outputMint: params.pair.bMint,
              amount: amountA,
              slippageBps: params.pair.slippageBps,
            })
          : await params.jupiter.order({
              inputMint: params.pair.aMint,
              outputMint: params.pair.bMint,
              amount: amountA,
              taker: params.wallet.publicKey.toBase58(),
            });

      const quote1OutMin = quote1.otherAmountThreshold;
      const quote2: QuoteResponse | UltraOrderResponse =
        params.jupiter.kind === 'swap-v1'
          ? await params.jupiter.quoteExactIn({
              inputMint: params.pair.bMint,
              outputMint: params.pair.aMint,
              amount: quote1OutMin,
              slippageBps: params.pair.slippageBps,
            })
          : await params.jupiter.order({
              inputMint: params.pair.bMint,
              outputMint: params.pair.aMint,
              amount: quote1OutMin,
              taker: params.wallet.publicKey.toBase58(),
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
        quote2MinOut: quote2.otherAmountThreshold,
      });

      const feeEstimateLamports = estimateFeeLamports({
        baseFeeLamports,
        rentBufferLamports,
        computeUnitLimit,
        computeUnitPriceMicroLamports,
        jitoTipLamports,
      });

      const decision = await decideWithOptionalRust({
        useRust: params.useRustCalc,
        rustCalcPath: params.rustCalcPath,
        amountIn: amountA,
        quote1Out: quote1.outAmount,
        quote1MinOut: quote1.otherAmountThreshold,
        quote2Out: quote2.outAmount,
        quote2MinOut: quote2.otherAmountThreshold,
        minProfit: params.pair.minProfitA,
        feeEstimateLamports,
      });

      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'candidate',
        pair: params.pair.name,
        amountA,
        slippageBps: params.pair.slippageBps,
        feeEstimateLamports,
        jitoTipLamports,
        profit: decision.profit,
        conservativeProfit: decision.conservativeProfit,
        profitable: decision.profitable,
      });

      candidates.push({ amountA, quote1, quote2, decision, feeEstimateLamports, jitoTipLamports });
    } catch (error) {
      await params.logEvent({
        ts: new Date().toISOString(),
        type: 'candidate_error',
        pair: params.pair.name,
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


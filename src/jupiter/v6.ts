import { fetchJson, withQuery } from '../lib/http.js';
import type { QuoteResponse, SwapInstructionsResponse, SwapTransactionResponse } from './types.js';

export function makeJupiterV6Client(baseUrl: string) {
  const root = baseUrl.replace(/\/$/, '');

  const quoteUrl = (params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    includeDexes?: string[];
    excludeDexes?: string[];
  }) =>
    withQuery(`${root}/quote`, {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps),
      swapMode: 'ExactIn',
      onlyDirectRoutes: 'false',
      // Metis/Jupiter v6 uses `dexes` to include-only.
      dexes: params.includeDexes?.length ? params.includeDexes : undefined,
      excludeDexes: params.excludeDexes?.length ? params.excludeDexes : undefined,
    });

  async function quoteExactIn(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    includeDexes?: string[];
    excludeDexes?: string[];
  }): Promise<QuoteResponse> {
    return await fetchJson<QuoteResponse>(quoteUrl(params), { timeoutMs: 15_000 });
  }

  async function buildSwapTransaction(params: {
    quote: QuoteResponse;
    userPublicKey: string;
    computeUnitPriceMicroLamports?: number;
  }): Promise<SwapTransactionResponse> {
    return await fetchJson<SwapTransactionResponse>(`${root}/swap`, {
      method: 'POST',
      body: {
        quoteResponse: params.quote,
        userPublicKey: params.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
      },
      timeoutMs: 20_000,
    });
  }

  async function buildSwapInstructions(params: {
    quote: QuoteResponse;
    userPublicKey: string;
    computeUnitPriceMicroLamports?: number;
  }): Promise<SwapInstructionsResponse> {
    return await fetchJson<SwapInstructionsResponse>(`${root}/swap-instructions`, {
      method: 'POST',
      body: {
        quoteResponse: params.quote,
        userPublicKey: params.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
      },
      timeoutMs: 20_000,
    });
  }

  return { quoteExactIn, buildSwapTransaction, buildSwapInstructions };
}


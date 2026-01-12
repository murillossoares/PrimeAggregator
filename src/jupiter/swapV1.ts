import { fetchJson, withQuery } from '../lib/http.js';
import type { QuoteResponse, SwapInstructionsResponse, SwapTransactionResponse } from './types.js';

export function makeJupiterSwapV1Client(baseUrl: string, apiKey: string) {
  const headers = { 'x-api-key': apiKey };
  const quoteUrl = (params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    includeDexes?: string[];
    excludeDexes?: string[];
  }) =>
    withQuery(`${baseUrl.replace(/\/$/, '')}/swap/v1/quote`, {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps),
      swapMode: 'ExactIn',
      onlyDirectRoutes: 'false',
      includeDexes: params.includeDexes?.length ? params.includeDexes : undefined,
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
    return await fetchJson<QuoteResponse>(quoteUrl(params), { headers });
  }

  async function buildSwapTransaction(params: {
    quote: QuoteResponse;
    userPublicKey: string;
    computeUnitPriceMicroLamports?: number;
  }): Promise<SwapTransactionResponse> {
    return await fetchJson<SwapTransactionResponse>(`${baseUrl.replace(/\/$/, '')}/swap/v1/swap`, {
      method: 'POST',
      headers,
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
    return await fetchJson<SwapInstructionsResponse>(
      `${baseUrl.replace(/\/$/, '')}/swap/v1/swap-instructions`,
      {
        method: 'POST',
        headers,
        body: {
          quoteResponse: params.quote,
          userPublicKey: params.userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
        },
        timeoutMs: 20_000,
      },
    );
  }

  return { quoteExactIn, buildSwapTransaction, buildSwapInstructions };
}

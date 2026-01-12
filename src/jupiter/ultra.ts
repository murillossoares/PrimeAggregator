import { fetchJson, withQuery } from '../lib/http.js';
import type { UltraOrderResponse, UltraExecuteResponse } from './types.js';

export function makeJupiterUltraClient(baseUrl: string, apiKey: string) {
  const headers = { 'x-api-key': apiKey };
  const root = baseUrl.replace(/\/$/, '');

  async function order(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    taker: string;
  }): Promise<UltraOrderResponse> {
    const url = withQuery(`${root}/ultra/v1/order`, {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      taker: params.taker,
    });
    return await fetchJson<UltraOrderResponse>(url, { headers, timeoutMs: 15_000 });
  }

  async function execute(params: {
    signedTransaction: string;
    requestId: string;
  }): Promise<UltraExecuteResponse> {
    const url = `${root}/ultra/v1/execute`;
    return await fetchJson<UltraExecuteResponse>(url, {
      method: 'POST',
      headers,
      body: params,
      timeoutMs: 20_000,
    });
  }

  return { order, execute };
}


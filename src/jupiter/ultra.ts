import { fetchJson, withQuery } from '../lib/http.js';
import type { UltraOrderResponse, UltraExecuteResponse } from './types.js';

export function makeJupiterUltraClient(baseUrl: string, apiKey: string) {
  const headers = { 'x-api-key': apiKey };
  const trimmed = baseUrl.replace(/\/$/, '');
  // Accept both forms:
  // - https://api.jup.ag
  // - https://api.jup.ag/ultra
  const root = trimmed.endsWith('/ultra') ? trimmed.slice(0, -'/ultra'.length) : trimmed;

  async function order(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    taker?: string;
    receiver?: string;
    payer?: string;
    closeAuthority?: string;
    referralAccount?: string;
    referralFee?: number;
    excludeRouters?: string;
    excludeDexes?: string;
  }): Promise<UltraOrderResponse> {
    const url = withQuery(`${root}/ultra/v1/order`, {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      taker: params.taker,
      receiver: params.receiver,
      payer: params.payer,
      closeAuthority: params.closeAuthority,
      referralAccount: params.referralAccount,
      referralFee: params.referralFee !== undefined ? String(params.referralFee) : undefined,
      excludeRouters: params.excludeRouters,
      excludeDexes: params.excludeDexes,
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

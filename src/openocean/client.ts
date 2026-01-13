import { fetchJson, withQuery } from '../lib/http.js';
import { MinIntervalRateLimiter } from '../lib/rateLimiter.js';
import type { OpenOceanApiResponse, OpenOceanQuote, OpenOceanQuoteData, OpenOceanSwapData } from './types.js';

function bpsToPercentString(bps: number): string {
  const safeBps = Math.max(0, Math.floor(bps));
  const whole = Math.floor(safeBps / 100);
  const frac = safeBps % 100;
  if (frac === 0) return String(whole);
  const trimmed = frac.toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}.${trimmed}`;
}

function atomicToDecimalString(amountAtomic: string, decimals: number): string {
  const digits = amountAtomic.replace(/^0+/, '') || '0';
  const d = Math.max(0, Math.floor(decimals));
  if (d === 0) return digits;

  if (digits.length <= d) {
    const padded = digits.padStart(d, '0');
    const frac = padded.replace(/0+$/, '');
    return frac.length ? `0.${frac}` : '0';
  }

  const intPart = digits.slice(0, digits.length - d);
  const fracPart = digits.slice(digits.length - d).replace(/0+$/, '');
  return fracPart.length ? `${intPart}.${fracPart}` : intPart;
}

export class OpenOceanClient {
  private readonly limiter: MinIntervalRateLimiter;

  constructor(
    private readonly config: {
      baseUrl?: string;
      apiKey?: string;
      minIntervalMs?: number;
      gasPrice?: number;
    } = {},
  ) {
    this.limiter = new MinIntervalRateLimiter(Math.max(0, Math.floor(config.minIntervalMs ?? 600)));
  }

  private get baseUrl() {
    return this.config.baseUrl ?? 'https://open-api.openocean.finance/v4/solana';
  }

  private get headers(): Record<string, string> | undefined {
    if (!this.config.apiKey) return undefined;
    return { 'x-api-key': this.config.apiKey };
  }

  private get gasPrice() {
    return Math.max(0, Math.floor(this.config.gasPrice ?? 5));
  }

  async quoteExactIn(params: {
    inputMint: string;
    outputMint: string;
    amountAtomic: string;
    inputDecimals: number;
    slippageBps: number;
  }): Promise<OpenOceanQuote> {
    const amount = atomicToDecimalString(params.amountAtomic, params.inputDecimals);
    const slippage = bpsToPercentString(params.slippageBps);

    const url = withQuery(`${this.baseUrl}/quote`, {
      inTokenAddress: params.inputMint,
      outTokenAddress: params.outputMint,
      amount,
      slippage,
      gasPrice: String(this.gasPrice),
    });

    const res = await this.limiter.schedule(() =>
      fetchJson<OpenOceanApiResponse<OpenOceanQuoteData>>(url, { headers: this.headers }),
    );

    if (res.code !== 200 || !res.data || res.data.code !== 0) {
      throw new Error(`OpenOcean quote failed: ${res.error ?? res.message ?? `code=${res.code}`}`);
    }

    return {
      provider: 'openocean',
      inputMint: res.data.inToken.address,
      outputMint: res.data.outToken.address,
      inAmount: res.data.inAmount,
      outAmount: res.data.outAmount,
      otherAmountThreshold: res.data.minOutAmount,
      slippageBps: params.slippageBps,
      dexId: res.data.dexId,
      raw: res.data,
    };
  }

  async swap(params: {
    inputMint: string;
    outputMint: string;
    amountAtomic: string;
    inputDecimals: number;
    slippageBps: number;
    account: string;
  }): Promise<OpenOceanSwapData> {
    const amount = atomicToDecimalString(params.amountAtomic, params.inputDecimals);
    const slippage = bpsToPercentString(params.slippageBps);

    const url = withQuery(`${this.baseUrl}/swap`, {
      inTokenAddress: params.inputMint,
      outTokenAddress: params.outputMint,
      amount,
      slippage,
      gasPrice: String(this.gasPrice),
      account: params.account,
    });

    const res = await this.limiter.schedule(() =>
      fetchJson<OpenOceanApiResponse<OpenOceanSwapData>>(url, { headers: this.headers }),
    );

    if (res.code !== 200 || !res.data || res.data.code !== 0) {
      throw new Error(`OpenOcean swap failed: ${res.error ?? res.message ?? `code=${res.code}`}`);
    }

    return res.data;
  }
}


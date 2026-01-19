import { fetchJson, withQuery } from '../lib/http.js';
import { MinIntervalRateLimiter } from '../lib/rateLimiter.js';
import type { OpenOceanApiResponse, OpenOceanQuote, OpenOceanQuoteData, OpenOceanSwapData } from './types.js';

function extractHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/\bHTTP\s+(\d{3})\b/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractOpenOceanBanMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  if (!normalized.includes('bann')) return undefined;

  const hourMatch = normalized.match(/banned[^.]*?for\s+(\d+)\s*(hour|hours|hr|hrs)\b/);
  if (hourMatch) {
    const hours = Number.parseInt(hourMatch[1] ?? '', 10);
    if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  }

  const minuteMatch = normalized.match(/banned[^.]*?for\s+(\d+)\s*(minute|minutes|min|mins)\b/);
  if (minuteMatch) {
    const minutes = Number.parseInt(minuteMatch[1] ?? '', 10);
    if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  }

  if (normalized.includes('banned') && (normalized.includes('one hour') || normalized.includes('an hour'))) {
    return 60 * 60 * 1000;
  }

  if (normalized.includes('banned')) {
    return 60 * 60 * 1000;
  }

  return undefined;
}

function bpsToPercentString(bps: number): string {
  const safeBps = Math.max(0, Math.floor(bps));
  const whole = Math.floor(safeBps / 100);
  const frac = safeBps % 100;
  if (frac === 0) return String(whole);
  const trimmed = frac.toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}.${trimmed}`;
}

export class OpenOceanClient {
  private readonly limiter: MinIntervalRateLimiter;
  private bannedUntilMs = 0;
  private readonly baseUrlValue?: string;

  constructor(
    private readonly config: {
      baseUrl?: string;
      apiKey?: string;
      minIntervalMs?: number;
      gasPrice?: number;
      enabledDexIds?: string;
      disabledDexIds?: string;
      referrer?: string;
      referrerFee?: string;
    } = {},
  ) {
    this.baseUrlValue = (() => {
      const raw = this.config.baseUrl?.trim();
      if (!raw) return undefined;
      const withScheme = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
      try {
        // Validate URL and keep only origin + pathname (strip query/fragment).
        const u = new URL(withScheme);
        return `${u.origin}${u.pathname}`.replace(/\/$/, '');
      } catch {
        return undefined;
      }
    })();
    this.limiter = new MinIntervalRateLimiter(Math.max(0, Math.floor(config.minIntervalMs ?? 1200)));
  }

  private get baseUrl() {
    return this.baseUrlValue ?? 'https://open-api.openocean.finance/v4/solana';
  }

  private get headers(): Record<string, string> | undefined {
    if (!this.config.apiKey) return undefined;
    return { 'x-api-key': this.config.apiKey };
  }

  private get gasPrice() {
    return Math.max(0, Math.floor(this.config.gasPrice ?? 5));
  }

  private assertNotBanned() {
    const now = Date.now();
    if (now < this.bannedUntilMs) {
      throw new Error(`OpenOcean temporarily banned until ${new Date(this.bannedUntilMs).toISOString()}`);
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    this.assertNotBanned();
    try {
      return await this.limiter.schedule(async () => {
        this.assertNotBanned();
        return await fn();
      });
    } catch (error) {
      const status = extractHttpStatus(error);
      if (status === 429) {
        const banMs = extractOpenOceanBanMs(error);
        const cooldownMs = banMs && banMs > 0 ? banMs : 10_000;
        this.bannedUntilMs = Math.max(this.bannedUntilMs, Date.now() + cooldownMs);
      } else if (status && status >= 500) {
        this.bannedUntilMs = Math.max(this.bannedUntilMs, Date.now() + 2000);
      }
      throw error;
    }
  }

  async quoteExactIn(params: {
    inputMint: string;
    outputMint: string;
    amountAtomic: string;
    slippageBps: number;
  }): Promise<OpenOceanQuote> {
    const slippage = bpsToPercentString(params.slippageBps);

    const url = withQuery(`${this.baseUrl}/quote`, {
      inTokenAddress: params.inputMint,
      outTokenAddress: params.outputMint,
      amountDecimals: params.amountAtomic,
      slippage,
      gasPriceDecimals: String(this.gasPrice),
      enabledDexIds: this.config.enabledDexIds,
      disabledDexIds: this.config.disabledDexIds,
    });

    const res = await this.call(() => fetchJson<OpenOceanApiResponse<OpenOceanQuoteData>>(url, { headers: this.headers }));

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
    slippageBps: number;
    account: string;
  }): Promise<OpenOceanSwapData> {
    const slippage = bpsToPercentString(params.slippageBps);

    const url = withQuery(`${this.baseUrl}/swap`, {
      inTokenAddress: params.inputMint,
      outTokenAddress: params.outputMint,
      amountDecimals: params.amountAtomic,
      slippage,
      gasPriceDecimals: String(this.gasPrice),
      account: params.account,
      enabledDexIds: this.config.enabledDexIds,
      disabledDexIds: this.config.disabledDexIds,
      referrer: this.config.referrer,
      referrerFee: this.config.referrerFee,
    });

    const res = await this.call(() => fetchJson<OpenOceanApiResponse<OpenOceanSwapData>>(url, { headers: this.headers }));

    if (res.code !== 200 || !res.data || res.data.code !== 0) {
      throw new Error(`OpenOcean swap failed: ${res.error ?? res.message ?? `code=${res.code}`}`);
    }

    return res.data;
  }
}

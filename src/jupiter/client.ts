import type { JupiterClient } from './types.js';
import { makeJupiterUltraClient } from './ultra.js';
import { makeJupiterSwapV1Client } from './swapV1.js';
import { makeJupiterV6Client } from './v6.js';

function isApiJupAgHost(url: string) {
  try {
    return new URL(url).hostname === 'api.jup.ag';
  } catch {
    return url.includes('api.jup.ag');
  }
}

export function makeJupiterClient(params: {
  swapBaseUrl: string;
  ultraBaseUrl: string;
  apiKey: string | undefined;
  useUltra: true;
}): Extract<JupiterClient, { kind: 'ultra' }>;
export function makeJupiterClient(params: {
  swapBaseUrl: string;
  ultraBaseUrl: string;
  apiKey: string | undefined;
  useUltra: false;
}): Extract<JupiterClient, { kind: 'swap-v1' } | { kind: 'v6' }>;
export function makeJupiterClient(params: {
  swapBaseUrl: string;
  ultraBaseUrl: string;
  apiKey: string | undefined;
  useUltra: boolean;
}): JupiterClient;
export function makeJupiterClient(params: {
  swapBaseUrl: string;
  ultraBaseUrl: string;
  apiKey: string | undefined;
  useUltra: boolean;
}): JupiterClient {
  if (params.useUltra) {
    if (!params.apiKey) {
      throw new Error('JUP_USE_ULTRA=true but JUP_API_KEY is missing');
    }
    return { kind: 'ultra', ...makeJupiterUltraClient(params.ultraBaseUrl, params.apiKey) };
  }

  // `https://api.jup.ag` is the authenticated Swap v1 API.
  // Metis / Jupiter v6 APIs are typically served via a different hostname (eg `public.jupiterapi.com`)
  // and do not require a Jupiter `x-api-key`.
  if (isApiJupAgHost(params.swapBaseUrl)) {
    if (!params.apiKey) {
      throw new Error('JUP_API_KEY is required for https://api.jup.ag/swap/v1/*');
    }
    return { kind: 'swap-v1', ...makeJupiterSwapV1Client(params.swapBaseUrl, params.apiKey) };
  }

  return { kind: 'v6', ...makeJupiterV6Client(params.swapBaseUrl) };
}

import type { JupiterClient } from './types.js';
import { makeJupiterUltraClient } from './ultra.js';
import { makeJupiterSwapV1Client } from './swapV1.js';

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

  if (!params.apiKey) {
    throw new Error('JUP_API_KEY is required for https://api.jup.ag/swap/v1/*');
  }
  return { kind: 'swap-v1', ...makeJupiterSwapV1Client(params.swapBaseUrl, params.apiKey) };
}

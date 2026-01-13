export type OpenOceanApiResponse<T> = {
  code: number;
  data?: T;
  error?: string;
  message?: string;
};

export type OpenOceanToken = {
  address: string;
  decimals: number;
  symbol?: string;
  name?: string;
  usd?: string;
};

export type OpenOceanDexQuote = {
  dexCode: string;
  dexIndex: number;
  swapAmount: string;
  minOutAmount: string;
  feeRatio?: number;
  time?: number;
  route?: unknown;
};

export type OpenOceanQuoteData = {
  code: number;
  dexes?: OpenOceanDexQuote[];
  inToken: OpenOceanToken;
  outToken: OpenOceanToken;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  dexId: number;
  feeRatio?: number;
  save?: number;
  price_impact?: string;
};

export type OpenOceanSwapData = {
  code: number;
  inToken: OpenOceanToken;
  outToken: OpenOceanToken;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  dexId: number;
  isVersioned?: boolean;
  lastValidBlockHeight?: number;
  feeRatio?: number;
  isTip?: boolean;
  estimatedGas?: number;
  data: string;
};

export type OpenOceanQuote = {
  provider: 'openocean';
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  dexId: number;
  raw: OpenOceanQuoteData;
};


export type QuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: unknown;
};

export type SwapTransactionResponse = {
  swapTransaction: string;
  lastValidBlockHeight?: number;
};

export type JupiterInstruction = {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
};

export type SwapInstructionsResponse = {
  otherInstructions: JupiterInstruction[];
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  addressLookupTableAddresses: string[];
  cleanupInstruction: JupiterInstruction | null;
};

export type UltraOrderResponse = QuoteResponse & {
  mode?: string;
  feeBps?: number;
  platformFee?: { feeBps?: number; amount?: string } | null;
  signatureFeeLamports?: number;
  signatureFeePayer?: string | null;
  prioritizationFeeLamports?: number;
  prioritizationFeePayer?: string | null;
  rentFeeLamports?: number;
  rentFeePayer?: string | null;
  swapType?: string;
  router?: string;
  gasless: boolean;
  requestId: string;
  totalTime?: number;
  taker: string | null;
  inUsdValue?: number;
  outUsdValue?: number;
  transaction: string | null;
};

export type UltraExecuteResponse = {
  status: string;
  code?: number;
  signature?: string;
  slot?: number | string;
  error?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
};

export type JupiterClient =
  | {
      kind: 'swap-v1';
      quoteExactIn(params: {
        inputMint: string;
        outputMint: string;
        amount: string;
        slippageBps: number;
        includeDexes?: string[];
        excludeDexes?: string[];
      }): Promise<QuoteResponse>;
      buildSwapTransaction(params: {
        quote: QuoteResponse;
        userPublicKey: string;
        computeUnitPriceMicroLamports?: number;
      }): Promise<SwapTransactionResponse>;
      buildSwapInstructions(params: {
        quote: QuoteResponse;
        userPublicKey: string;
        computeUnitPriceMicroLamports?: number;
      }): Promise<SwapInstructionsResponse>;
    }
  | {
      // Metis extends Jupiter Swap v6 API: /quote, /swap, /swap-instructions
      kind: 'v6';
      quoteExactIn(params: {
        inputMint: string;
        outputMint: string;
        amount: string;
        slippageBps: number;
        includeDexes?: string[];
        excludeDexes?: string[];
      }): Promise<QuoteResponse>;
      buildSwapTransaction(params: {
        quote: QuoteResponse;
        userPublicKey: string;
        computeUnitPriceMicroLamports?: number;
      }): Promise<SwapTransactionResponse>;
      buildSwapInstructions(params: {
        quote: QuoteResponse;
        userPublicKey: string;
        computeUnitPriceMicroLamports?: number;
      }): Promise<SwapInstructionsResponse>;
    }
  | {
      kind: 'ultra';
      order(params: {
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
      }): Promise<UltraOrderResponse>;
      execute(params: { signedTransaction: string; requestId: string }): Promise<UltraExecuteResponse>;
    };

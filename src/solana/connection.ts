import { Connection, type Commitment } from '@solana/web3.js';

export function makeConnection(params: { rpcUrl: string; wsUrl?: string; commitment: Commitment }) {
  return new Connection(params.rpcUrl, {
    commitment: params.commitment,
    wsEndpoint: params.wsUrl,
  });
}

import { Connection } from '@solana/web3.js';

export function makeConnection(rpcUrl: string) {
  return new Connection(rpcUrl, {
    commitment: 'confirmed',
  });
}


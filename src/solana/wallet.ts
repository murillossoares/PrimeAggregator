import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

function isProbablyJsonArray(s: string) {
  const t = s.trim();
  return t.startsWith('[') && t.endsWith(']');
}

export function loadWallet(secret: string): Keypair {
  const trimmed = secret.trim();

  if (trimmed.length === 0) throw new Error('WALLET_SECRET_KEY is empty');

  if (isProbablyJsonArray(trimmed)) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  try {
    const file = readFileSync(trimmed, 'utf8');
    const arr = JSON.parse(file) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    // ignore and try base58
  }

  return Keypair.fromSecretKey(bs58.decode(trimmed));
}


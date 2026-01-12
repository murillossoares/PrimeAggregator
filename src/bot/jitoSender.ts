import { PublicKey, type Keypair, type VersionedTransaction } from '@solana/web3.js';

const DEFAULT_TIP_ACCOUNTS = [
  '96gYZGLnJFVFzxGxSPXP4yw4sVQNgv24QLCUYzG3M55j',
  'DfXygSm4jCyNCybVYYK6DwvWqjKkf8tX74BdX5UE8Cu',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PuyAC8eFk978Zs',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADuUkR4ykGytmnb5LHydoG36hJks29537yW5Up568TH4',
  'DttWaMuVvTiduZRNgLcGW9w6fb55dU5CtQnEpUlTujLx',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnIzKZ6jT',
];

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function getJitoTipAccountAddress(preferred?: string): string {
  if (preferred && preferred.trim().length > 0) {
    const candidate = preferred.trim();
    try {
      // Validate base58/pubkey format; if invalid, fall back to defaults.
      // This prevents values like "false" from crashing the bot.
      new PublicKey(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }
  return pickRandom(DEFAULT_TIP_ACCOUNTS);
}

export type JitoBundleResultJson = {
  bundleId: string;
  accepted?: unknown;
  rejected?: unknown;
  finalized?: unknown;
  processed?: unknown;
  dropped?: unknown;
};

export async function sendBundleViaJito(params: {
  blockEngineUrl: string;
  authKeypair: Keypair;
  transaction: VersionedTransaction;
  waitMs?: number;
}): Promise<{ bundleId: string; result?: JitoBundleResultJson }> {
  // Dynamic import to avoid module format issues at startup.
  const { searcherClient } = (await import('jito-ts/dist/sdk/block-engine/searcher.js')) as any;
  const { Bundle } = (await import('jito-ts/dist/sdk/block-engine/types.js')) as any;
  const { BundleResult } = (await import('jito-ts/dist/gen/block-engine/bundle.js')) as any;

  const url = params.blockEngineUrl.startsWith('http') ? params.blockEngineUrl : `https://${params.blockEngineUrl}`;
  const client = searcherClient(url, params.authKeypair);
  const bundle = new Bundle([params.transaction], 3);
  const bundleId: string = await client.sendBundle(bundle);

  const waitMs = Math.max(0, Math.floor(params.waitMs ?? 0));
  if (waitMs === 0) return { bundleId };

  const result = await new Promise<any | undefined>((resolve, reject) => {
    let settled = false;
    let cancel = () => {};

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(undefined);
    }, waitMs);

    cancel = client.onBundleResult(
      (msg: any) => {
        if (settled) return;
        if (msg?.bundleId !== bundleId) return;
        settled = true;
        clearTimeout(timer);
        cancel();
        resolve(BundleResult?.toJSON ? (BundleResult.toJSON(msg) as JitoBundleResultJson) : (msg as JitoBundleResultJson));
      },
      (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancel();
        reject(e);
      },
    );
  });

  return { bundleId, result };
}

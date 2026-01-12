import 'dotenv/config';

import { loadConfig } from './lib/config.js';
import { sleep } from './lib/time.js';
import { loadWallet } from './solana/wallet.js';
import { makeConnection } from './solana/connection.js';
import { makeJupiterClient } from './jupiter/client.js';
import { scanAndMaybeExecute } from './bot/loop.js';
import { getEnv } from './lib/env.js';
import { createJsonlLogger } from './lib/logger.js';
import { setupWalletTokenAccounts } from './solana/setupWallet.js';

function parseArgs(argv: string[]) {
  const args = new Set(argv.slice(2));
  return {
    once: args.has('--once'),
    setupWallet: args.has('--setup-wallet'),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const env = getEnv();

  const config = await loadConfig(env.configPath);
  const connection = makeConnection(env.solanaRpcUrl);
  const wallet = loadWallet(env.walletSecretKey);
  const balanceLamports = await connection.getBalance(wallet.publicKey, 'confirmed');
  const logEvent = createJsonlLogger(env.logPath);

  const jupiter = makeJupiterClient({
    swapBaseUrl: env.jupSwapBaseUrl,
    ultraBaseUrl: env.jupUltraBaseUrl,
    apiKey: env.jupApiKey,
    useUltra: env.jupUseUltra,
  });

  console.log(
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        mode: env.mode,
        pairs: config.pairs.length,
        useUltra: jupiter.kind,
        pubkey: wallet.publicKey.toBase58(),
        balanceLamports,
      },
      null,
      2,
    ),
  );

  await logEvent({
    ts: new Date().toISOString(),
    type: 'startup',
    mode: env.mode,
    executionStrategy: env.executionStrategy,
    pairs: config.pairs.length,
    pubkey: wallet.publicKey.toBase58(),
    balanceLamports,
  });

  if (args.setupWallet) {
    const mints = config.pairs.flatMap((pair) => [pair.aMint, pair.bMint]);
    const signatures = await setupWalletTokenAccounts({ connection, wallet, mintAddresses: mints });
    console.log(JSON.stringify({ ts: new Date().toISOString(), setupWallet: true, signatures }, null, 2));
    return;
  }

  const cooldowns = new Map<string, number>();
  do {
    for (const pair of config.pairs) {
      const now = Date.now();
      const nextAllowedAt = cooldowns.get(pair.name);
      if (nextAllowedAt && now < nextAllowedAt) {
        continue;
      }
      try {
        const result = await scanAndMaybeExecute({
          connection,
          wallet,
          jupiter,
          mode: env.mode,
          executionStrategy: env.executionStrategy,
          dryRunBuild: env.dryRunBuild,
          dryRunSimulate: env.dryRunSimulate,
          logEvent,
          baseFeeLamports: env.baseFeeLamports,
          rentBufferLamports: env.rentBufferLamports,
          computeUnitLimit: env.computeUnitLimit,
          computeUnitPriceMicroLamports: env.computeUnitPriceMicroLamports,
          pair,
          useRustCalc: env.useRustCalc,
          rustCalcPath: env.rustCalcPath,
        });
        if (pair.cooldownMs > 0 && result.kind !== 'skipped') {
          cooldowns.set(pair.name, Date.now() + pair.cooldownMs);
        }
      } catch (error) {
        if (pair.cooldownMs > 0) {
          cooldowns.set(pair.name, Date.now() + pair.cooldownMs);
        }
        await logEvent({ ts: new Date().toISOString(), type: 'error', pair: pair.name, error: String(error) });
        console.error(
          JSON.stringify(
            { ts: new Date().toISOString(), pair: pair.name, error: String(error) },
            null,
            2,
          ),
        );
      }
    }

    if (args.once) break;
    await sleep(env.pollIntervalMs);
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

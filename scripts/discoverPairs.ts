import 'dotenv/config';

import { writeFile, readFile } from 'node:fs/promises';

import { makeJupiterClient } from '../src/jupiter/client.js';
import { AdaptiveTokenBucketRateLimiter } from '../src/lib/rateLimiter.js';

type CandidateToken = { mint: string; symbol?: string; name?: string };

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function asInt(value: unknown, fallback: number) {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function asFloat(value: unknown, fallback: number) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function parseCsv(value: string | undefined) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePriceImpactBps(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().replace('%', '');
  if (!normalized) return undefined;
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n <= 1) return Math.round(n * 10_000);
  if (n <= 100) return Math.round(n * 100);
  return undefined;
}

function routeHops(routePlan: unknown): number | undefined {
  if (!Array.isArray(routePlan)) return undefined;
  return routePlan.length;
}

async function fetchTokenList(url: string): Promise<CandidateToken[]> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`token list HTTP ${res.status}: ${url}`);
  const data = (await res.json()) as any;
  if (!Array.isArray(data)) throw new Error('token list is not an array');
  const out: CandidateToken[] = [];
  for (const t of data) {
    if (!t || typeof t !== 'object') continue;
    const mint = typeof t.address === 'string' ? t.address : typeof t.mint === 'string' ? t.mint : undefined;
    if (!mint || !mint.trim()) continue;
    out.push({ mint: mint.trim(), symbol: typeof t.symbol === 'string' ? t.symbol : undefined, name: typeof t.name === 'string' ? t.name : undefined });
  }
  return out;
}

async function readTokensFromFile(path: string): Promise<CandidateToken[]> {
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed) as any;
    if (Array.isArray(json)) {
      return json
        .map((v) => {
          if (typeof v === 'string') return { mint: v };
          if (v && typeof v === 'object' && typeof v.mint === 'string') return { mint: v.mint, symbol: v.symbol, name: v.name };
          if (v && typeof v === 'object' && typeof v.address === 'string') return { mint: v.address, symbol: v.symbol, name: v.name };
          return undefined;
        })
        .filter((x): x is CandidateToken => Boolean(x?.mint));
    }
    if (json && typeof json === 'object' && Array.isArray(json.tokens)) {
      return (json.tokens as any[])
        .map((v) => (typeof v === 'string' ? ({ mint: v } as CandidateToken) : v && typeof v === 'object' ? ({ mint: v.mint ?? v.address, symbol: v.symbol, name: v.name } as CandidateToken) : undefined))
        .filter((x): x is CandidateToken => Boolean(x?.mint));
    }
  }

  return trimmed
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((mint) => ({ mint }));
}

async function main() {
  const args = parseArgs(process.argv);

  const outPath = (args['out'] as string) ?? './config.generated.json';
  const aMint = ((args['aMint'] as string) ?? process.env.DISCOVER_AMINT ?? SOL_MINT).trim();
  const amountA = ((args['amountA'] as string) ?? process.env.DISCOVER_AMOUNT_A ?? '5000000').trim();
  const slippageBps = asInt(args['slippageBps'] ?? process.env.DISCOVER_SLIPPAGE_BPS, 50);

  const maxTokens = asInt(args['maxTokens'] ?? process.env.DISCOVER_MAX_TOKENS, 50);
  const maxPriceImpactBps = asInt(args['maxPriceImpactBps'] ?? process.env.DISCOVER_MAX_PRICE_IMPACT_BPS, 150);
  const maxRouteHops = asInt(args['maxRouteHops'] ?? process.env.DISCOVER_MAX_ROUTE_HOPS, 4);
  const baseMinProfitBps = asInt(args['baseMinProfitBps'] ?? process.env.DISCOVER_BASE_MIN_PROFIT_BPS, 50);

  const cooldownMs = asInt(args['cooldownMs'] ?? process.env.DISCOVER_COOLDOWN_MS, 1500);
  const cooldownOnLossMs = asInt(args['cooldownOnLossMs'] ?? process.env.DISCOVER_COOLDOWN_ON_LOSS_MS, 60_000);
  const maxTradesPerHour = asInt(args['maxTradesPerHour'] ?? process.env.DISCOVER_MAX_TRADES_PER_HOUR, 30);
  const maxDailyLossA = ((args['maxDailyLossA'] as string) ?? process.env.DISCOVER_MAX_DAILY_LOSS_A ?? '2000000').trim();

  const includeSymbols = parseCsv((args['includeSymbols'] as string) ?? process.env.DISCOVER_INCLUDE_SYMBOLS);
  const excludeSymbols = parseCsv((args['excludeSymbols'] as string) ?? process.env.DISCOVER_EXCLUDE_SYMBOLS);

  const blacklistMints = new Set<string>(parseCsv(process.env.BLACKLIST_MINTS));
  const blacklistPairs = new Set<string>(parseCsv(process.env.BLACKLIST_PAIRS));

  const jupQuoteBaseUrl = (process.env.JUP_QUOTE_BASE_URL && process.env.JUP_QUOTE_BASE_URL.trim().length > 0 ? process.env.JUP_QUOTE_BASE_URL : process.env.JUP_SWAP_BASE_URL) ?? 'https://api.jup.ag';
  const jupUltraBaseUrl = process.env.JUP_ULTRA_BASE_URL ?? 'https://api.jup.ag';
  const jupApiKey = process.env.JUP_API_KEY;

  const limiter = new AdaptiveTokenBucketRateLimiter({
    rps: Math.max(0.2, asFloat(process.env.DISCOVER_JUP_RPS, 1)),
    burst: Math.max(1, asInt(process.env.DISCOVER_JUP_BURST, 1)),
    penaltyMs: 60_000,
  });

  const jupiter = makeJupiterClient({
    swapBaseUrl: jupQuoteBaseUrl,
    ultraBaseUrl: jupUltraBaseUrl,
    apiKey: jupApiKey,
    useUltra: false,
  });

  const tokenListUrl =
    (args['tokenListUrl'] as string) ??
    process.env.DISCOVER_TOKEN_LIST_URL ??
    'https://token.jup.ag/strict';
  const tokensFile = (args['tokensFile'] as string) ?? process.env.DISCOVER_TOKENS_FILE;

  const tokens = tokensFile ? await readTokensFromFile(tokensFile) : await fetchTokenList(tokenListUrl);

  const picked: CandidateToken[] = [];
  for (const t of tokens) {
    const mint = t.mint.trim();
    if (!mint) continue;
    if (mint === aMint) continue;
    if (blacklistMints.has(mint)) continue;
    if (mint === SOL_MINT && aMint === SOL_MINT) continue;

    if (includeSymbols.length && (!t.symbol || !includeSymbols.includes(t.symbol))) continue;
    if (excludeSymbols.length && t.symbol && excludeSymbols.includes(t.symbol)) continue;

    picked.push({ mint, symbol: t.symbol, name: t.name });
    if (picked.length >= Math.max(1, maxTokens)) break;
  }

  const pairs: any[] = [];
  for (const t of picked) {
    const bMint = t.mint;
    const symbol = t.symbol?.trim() || bMint.slice(0, 6);
    const name = `SOL/${symbol} loop`;
    if (blacklistPairs.has(name)) continue;

    try {
      const q1 = await limiter.schedule(() =>
        jupiter.quoteExactIn({
          inputMint: aMint,
          outputMint: bMint,
          amount: amountA,
          slippageBps,
        }),
      );
      limiter.noteSuccess();

      const q2 = await limiter.schedule(() =>
        jupiter.quoteExactIn({
          inputMint: bMint,
          outputMint: aMint,
          amount: q1.otherAmountThreshold,
          slippageBps,
        }),
      );
      limiter.noteSuccess();

      const impactBps = Math.max(
        parsePriceImpactBps(q1.priceImpactPct) ?? 0,
        parsePriceImpactBps(q2.priceImpactPct) ?? 0,
      );
      const hops = Math.max(routeHops(q1.routePlan) ?? 0, routeHops(q2.routePlan) ?? 0);

      if (impactBps > maxPriceImpactBps) continue;
      if (hops > maxRouteHops) continue;

      const minProfitBps = Math.min(
        10_000,
        baseMinProfitBps + Math.ceil(impactBps / 25) + Math.max(0, hops - 1) * 10,
      );

      pairs.push({
        name,
        aMint,
        bMint,
        amountA,
        amountASteps: [amountA],
        minNotionalA: amountA,
        slippageBps,
        slippageBpsLeg2: Math.min(5000, Math.max(slippageBps, slippageBps * 2)),
        minProfitA: '0',
        minProfitBps,
        cooldownMs,
        cooldownOnLossMs,
        maxTradesPerHour,
        maxDailyLossA,
        maxNotionalA: amountA,
        maxPriceImpactBps,
        maxRouteHops,
      });
    } catch {
      limiter.note429();
      continue;
    }
  }

  const generated = { pairs };
  await writeFile(outPath, JSON.stringify(generated, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, out: outPath, pairs: pairs.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


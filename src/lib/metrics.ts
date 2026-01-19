import type { LogEvent } from './logger.js';

type ScanWindowEntry = {
  tsMs: number;
  jupiterQuoteCalls: number;
  openOceanQuoteCalls: number;
  feeConversionQuoteCalls: number;
};

type PairMetrics = {
  aMint?: string;
  bMint?: string;
  scans: number;
  scanMsTotal: number;
  candidatesTotal: number;
  jupiterQuoteCallsTotal: number;
  openOceanQuoteCallsTotal: number;
  feeConversionQuoteCallsTotal: number;
  rateLimits: { jupiter: number; ultra: number; openocean: number };
  executed: number;
  wins: number;
  losses: number;
  pnlSolLamportsTotal: number;
  pnlAAtomicTotal?: string;
  lastPnl?: Record<string, unknown>;
  errors: number;
  candidateErrors: number;
  skips: Record<string, number>;
  pairLimitSkips: Record<string, number>;
  pnlLeftovers: number;
  window: ScanWindowEntry[];
};

function asString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asInt(value: unknown) {
  const n = asNumber(value);
  if (n === undefined) return undefined;
  return Math.trunc(n);
}

function asType(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function addSkip(metrics: PairMetrics, reason: string) {
  metrics.skips[reason] = (metrics.skips[reason] ?? 0) + 1;
}

function addPairLimitSkip(metrics: PairMetrics, reason: string) {
  metrics.pairLimitSkips[reason] = (metrics.pairLimitSkips[reason] ?? 0) + 1;
}

export class MetricsCollector {
  private readonly perPair = new Map<string, PairMetrics>();
  private readonly startedAtMs = Date.now();

  private getPair(name: string) {
    const existing = this.perPair.get(name);
    if (existing) return existing;
    const created: PairMetrics = {
      scans: 0,
      scanMsTotal: 0,
      candidatesTotal: 0,
      jupiterQuoteCallsTotal: 0,
      openOceanQuoteCallsTotal: 0,
      feeConversionQuoteCallsTotal: 0,
      rateLimits: { jupiter: 0, ultra: 0, openocean: 0 },
      executed: 0,
      wins: 0,
      losses: 0,
      pnlSolLamportsTotal: 0,
      pnlAAtomicTotal: undefined,
      lastPnl: undefined,
      errors: 0,
      candidateErrors: 0,
      skips: {},
      pairLimitSkips: {},
      pnlLeftovers: 0,
      window: [],
    };
    this.perPair.set(name, created);
    return created;
  }

  observe(event: LogEvent) {
    const type = asType(event['type']);
    const pair = asString(event['pair']);
    if (!type) return;

    const now = Date.now();
    if (pair) {
      const m = this.getPair(pair);

      if (type === 'scan_summary') {
        m.scans += 1;
        m.scanMsTotal += asInt(event['scanMs']) ?? 0;
        m.candidatesTotal += asInt(event['candidates']) ?? 0;
        const jCalls = asInt(event['jupiterQuoteCalls']) ?? 0;
        const oCalls = asInt(event['openOceanQuoteCalls']) ?? 0;
        const fCalls = asInt(event['feeConversionQuoteCalls']) ?? 0;
        m.jupiterQuoteCallsTotal += jCalls;
        m.openOceanQuoteCallsTotal += oCalls;
        m.feeConversionQuoteCallsTotal += fCalls;
        m.window.push({ tsMs: now, jupiterQuoteCalls: jCalls, openOceanQuoteCalls: oCalls, feeConversionQuoteCalls: fCalls });

        const cutoff = now - 60_000;
        while (m.window.length && m.window[0]!.tsMs < cutoff) m.window.shift();
      } else if (type === 'candidate_error') {
        m.candidateErrors += 1;
      } else if (type === 'error') {
        m.errors += 1;
      } else if (type === 'skip' || type === 'openocean_skip') {
        addSkip(m, asString(event['reason']) ?? 'unknown');
      } else if (type === 'pair_limit_skip') {
        addPairLimitSkip(m, asString(event['reason']) ?? 'unknown');
      } else if (type === 'rate_limit') {
        const provider = asString(event['provider']);
        if (provider === 'jupiter') m.rateLimits.jupiter += 1;
        else if (provider === 'ultra') m.rateLimits.ultra += 1;
        else if (provider === 'openocean') m.rateLimits.openocean += 1;
      } else if (type === 'executed') {
        m.executed += 1;
      } else if (type === 'pnl_leftover') {
        m.pnlLeftovers += 1;
      } else if (type === 'pnl') {
        const aMint = asString(event['aMint']);
        const bMint = asString(event['bMint']);
        if (aMint) m.aMint = aMint;
        if (bMint) m.bMint = bMint;

        const deltaSol = asInt(event['deltaSolLamports']);
        if (deltaSol !== undefined) m.pnlSolLamportsTotal += deltaSol;

        const deltaA = asString(event['deltaAAtomic']);
        if (deltaA && /^\-?\d+$/.test(deltaA)) {
          try {
            const prev = m.pnlAAtomicTotal && /^\-?\d+$/.test(m.pnlAAtomicTotal) ? BigInt(m.pnlAAtomicTotal) : 0n;
            m.pnlAAtomicTotal = (prev + BigInt(deltaA)).toString();
            if (BigInt(deltaA) >= 0n) m.wins += 1;
            else m.losses += 1;
          } catch {
            // ignore
          }
        } else if (deltaSol !== undefined) {
          if (deltaSol >= 0) m.wins += 1;
          else m.losses += 1;
        }

        m.lastPnl = event;
      }
    }
  }

  snapshot() {
    const now = Date.now();
    const uptimeMs = now - this.startedAtMs;

    const pairs: Record<string, unknown> = {};
    for (const [name, m] of this.perPair.entries()) {
      const windowSeconds = 60;
      const jCalls = m.window.reduce((acc, e) => acc + e.jupiterQuoteCalls, 0);
      const oCalls = m.window.reduce((acc, e) => acc + e.openOceanQuoteCalls, 0);
      const fCalls = m.window.reduce((acc, e) => acc + e.feeConversionQuoteCalls, 0);
      pairs[name] = {
        aMint: m.aMint,
        bMint: m.bMint,
        scans: m.scans,
        avgScanMs: m.scans > 0 ? Math.round(m.scanMsTotal / m.scans) : 0,
        candidatesTotal: m.candidatesTotal,
        executed: m.executed,
        wins: m.wins,
        losses: m.losses,
        winRate: m.wins + m.losses > 0 ? Number((m.wins / (m.wins + m.losses)).toFixed(4)) : 0,
        pnlSolLamportsTotal: m.pnlSolLamportsTotal,
        pnlAAtomicTotal: m.pnlAAtomicTotal,
        quotesPerSecond: {
          jupiter: Number((jCalls / windowSeconds).toFixed(3)),
          openOcean: Number((oCalls / windowSeconds).toFixed(3)),
          feeConversion: Number((fCalls / windowSeconds).toFixed(3)),
        },
        rateLimits: m.rateLimits,
        errors: m.errors,
        candidateErrors: m.candidateErrors,
        skips: m.skips,
        pairLimitSkips: m.pairLimitSkips,
        pnlLeftovers: m.pnlLeftovers,
        lastPnl: m.lastPnl,
      };
    }

    return { uptimeMs, pairs };
  }
}

import { sleep } from './time.js';

export class MinIntervalRateLimiter {
  private lastRunAtMs = 0;
  private cooldownUntilMs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  cooldown(ms: number) {
    const waitMs = Math.max(0, Math.floor(ms));
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, Date.now() + waitMs);
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const now = Date.now();
      const waitIntervalMs = this.lastRunAtMs + this.minIntervalMs - now;
      const waitCooldownMs = this.cooldownUntilMs - now;
      const waitMs = Math.max(waitIntervalMs, waitCooldownMs);
      if (waitMs > 0) await sleep(waitMs);
      this.lastRunAtMs = Date.now();
      return await fn();
    };

    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type AdaptiveTokenBucketSnapshot = {
  baseRps: number;
  currentRps: number;
  minRps: number;
  burst: number;
  tokens: number;
  cooldownMsRemaining: number;
  penaltyMsRemaining: number;
  totalCalls: number;
  total429: number;
  last429At?: string;
};

export class AdaptiveTokenBucketRateLimiter {
  private readonly baseRps: number;
  private readonly minRps: number;
  private readonly burst: number;
  private readonly penaltyMs: number;
  private readonly recoveryEveryMs: number;
  private readonly recoveryStepRps: number;

  private tokens: number;
  private lastRefillAtMs = Date.now();
  private cooldownUntilMs = 0;
  private penaltyUntilMs = 0;
  private lastRecoveryAtMs = 0;
  private currentRps: number;
  private chain: Promise<void> = Promise.resolve();

  private totalCalls = 0;
  private total429 = 0;
  private last429AtMs = 0;

  constructor(config: {
    rps: number;
    burst: number;
    minRps?: number;
    penaltyMs?: number;
    recoveryEveryMs?: number;
    recoveryStepRps?: number;
  }) {
    const base = Number.isFinite(config.rps) ? config.rps : 1;
    this.baseRps = Math.max(0.1, base);
    this.minRps = Math.max(0.05, Number.isFinite(config.minRps) ? (config.minRps as number) : this.baseRps * 0.25);
    this.burst = Math.max(1, Math.floor(config.burst));
    this.penaltyMs = Math.max(1000, Math.floor(config.penaltyMs ?? 120_000));
    this.recoveryEveryMs = Math.max(1000, Math.floor(config.recoveryEveryMs ?? 10_000));
    this.recoveryStepRps = Math.max(0.05, Number.isFinite(config.recoveryStepRps) ? (config.recoveryStepRps as number) : 0.1);

    this.tokens = this.burst;
    this.currentRps = this.baseRps;
  }

  cooldown(ms: number) {
    const waitMs = Math.max(0, Math.floor(ms));
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, Date.now() + waitMs);
  }

  note429() {
    this.total429 += 1;
    this.last429AtMs = Date.now();
    this.currentRps = Math.max(this.minRps, this.currentRps * 0.5);
    this.penaltyUntilMs = Math.max(this.penaltyUntilMs, Date.now() + this.penaltyMs);
    this.lastRecoveryAtMs = Date.now();
  }

  noteSuccess() {
    const now = Date.now();
    if (now < this.penaltyUntilMs) return;
    if (this.currentRps >= this.baseRps) return;
    if (now - this.lastRecoveryAtMs < this.recoveryEveryMs) return;
    this.currentRps = Math.min(this.baseRps, this.currentRps + this.recoveryStepRps);
    this.lastRecoveryAtMs = now;
  }

  private refill(now: number) {
    const elapsedMs = Math.max(0, now - this.lastRefillAtMs);
    const rps = Math.max(0.01, this.currentRps);
    const refill = (elapsedMs / 1000) * rps;
    this.tokens = Math.min(this.burst, this.tokens + refill);
    this.lastRefillAtMs = now;
  }

  snapshot(): AdaptiveTokenBucketSnapshot {
    const now = Date.now();
    const penaltyMsRemaining = Math.max(0, this.penaltyUntilMs - now);
    const cooldownMsRemaining = Math.max(0, this.cooldownUntilMs - now);
    return {
      baseRps: this.baseRps,
      currentRps: this.currentRps,
      minRps: this.minRps,
      burst: this.burst,
      tokens: Math.max(0, this.tokens),
      cooldownMsRemaining,
      penaltyMsRemaining,
      totalCalls: this.totalCalls,
      total429: this.total429,
      last429At: this.last429AtMs ? new Date(this.last429AtMs).toISOString() : undefined,
    };
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.totalCalls += 1;

      while (true) {
        const now = Date.now();
        const waitCooldownMs = this.cooldownUntilMs - now;
        if (waitCooldownMs > 0) {
          await sleep(waitCooldownMs);
          continue;
        }

        this.refill(now);
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return await fn();
        }

        const rps = Math.max(0.01, this.currentRps);
        const missing = 1 - this.tokens;
        const waitMs = Math.ceil((missing / rps) * 1000);
        await sleep(Math.max(1, waitMs));
      }
    };

    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

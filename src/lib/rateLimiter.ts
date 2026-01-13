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

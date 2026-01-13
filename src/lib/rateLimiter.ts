import { sleep } from './time.js';

export class MinIntervalRateLimiter {
  private lastRunAtMs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const now = Date.now();
      const waitMs = this.lastRunAtMs + this.minIntervalMs - now;
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


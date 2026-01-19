function extractHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/\bHTTP\s+(\d{3})\b/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isHttp429(error: unknown) {
  return extractHttpStatus(error) === 429;
}

export class ProviderCircuitBreaker {
  private readonly openUntilMsByKey = new Map<string, number>();

  isOpen(key: string) {
    const until = this.openUntilMsByKey.get(key);
    if (!until) return false;
    return Date.now() < until;
  }

  remainingMs(key: string) {
    const until = this.openUntilMsByKey.get(key);
    if (!until) return 0;
    return Math.max(0, until - Date.now());
  }

  open(key: string, cooldownMs: number) {
    const ms = Math.max(0, Math.floor(cooldownMs));
    if (ms <= 0) return;
    const until = Date.now() + ms;
    const prev = this.openUntilMsByKey.get(key) ?? 0;
    if (until > prev) this.openUntilMsByKey.set(key, until);
  }

  noteHttp429(key: string, cooldownMs: number, error: unknown) {
    if (!isHttp429(error)) return false;
    this.open(key, cooldownMs);
    return true;
  }
}


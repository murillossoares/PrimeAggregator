import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogEvent = Record<string, unknown>;
export type Logger = (event: LogEvent) => Promise<void>;

export function createJsonlLogger(
  path: string,
  options: {
    rotateMaxBytes?: number;
    rotateMaxFiles?: number;
  } = {},
): Logger {
  let ensured = false;
  let knownSize: number | undefined;
  let chain: Promise<void> = Promise.resolve();

  async function ensureDir() {
    if (ensured) return;
    ensured = true;
    await mkdir(dirname(path), { recursive: true });
  }

  async function getCurrentSize(): Promise<number> {
    if (knownSize !== undefined) return knownSize;
    try {
      const s = await stat(path);
      knownSize = Number(s.size);
      return knownSize;
    } catch {
      knownSize = 0;
      return 0;
    }
  }

  async function rotateIfNeeded(nextBytes: number) {
    const maxBytes = Math.max(0, Math.floor(options.rotateMaxBytes ?? 0));
    const maxFiles = Math.max(0, Math.floor(options.rotateMaxFiles ?? 0));
    if (maxBytes <= 0 || maxFiles <= 0) return;

    const currentSize = await getCurrentSize();
    if (currentSize + nextBytes <= maxBytes) return;

    await ensureDir();

    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      try {
        await rename(from, to);
      } catch (error) {
        const code = error instanceof Error ? (error as any).code : undefined;
        if (code !== 'ENOENT') throw error;
      }
    }

    try {
      await rename(path, `${path}.1`);
    } catch (error) {
      const code = error instanceof Error ? (error as any).code : undefined;
      if (code !== 'ENOENT') throw error;
    }

    knownSize = 0;
  }

  return async (event: LogEvent) => {
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');

    const run = async () => {
      await ensureDir();
      await rotateIfNeeded(bytes);
      await appendFile(path, line, 'utf8');
      if (knownSize !== undefined) knownSize += bytes;
    };

    const next = chain.then(run, run);
    chain = next.then(
      () => undefined,
      () => undefined,
    );

    await next;
  };
}

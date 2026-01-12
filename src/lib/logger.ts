import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogEvent = Record<string, unknown>;
export type Logger = (event: LogEvent) => Promise<void>;

export function createJsonlLogger(path: string): Logger {
  let ensured = false;

  async function ensureDir() {
    if (ensured) return;
    ensured = true;
    await mkdir(dirname(path), { recursive: true });
  }

  return async (event: LogEvent) => {
    await ensureDir();
    const line = `${JSON.stringify(event)}\n`;
    await appendFile(path, line, 'utf8');
  };
}


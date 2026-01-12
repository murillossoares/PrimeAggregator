export type FetchJsonOptions = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
};

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : undefined),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}${text ? `: ${text}` : ''}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function withQuery(url: string, query: Record<string, string | readonly string[] | undefined>) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (typeof v === 'string') {
      u.searchParams.set(k, v);
      continue;
    }
    for (const item of v) {
      u.searchParams.append(k, item);
    }
  }
  return u.toString();
}

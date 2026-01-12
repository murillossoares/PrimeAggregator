export async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(limit));
  const queue = items.slice();

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });

  await Promise.all(workers);
}


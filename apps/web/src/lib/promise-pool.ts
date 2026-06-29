/**
 * How many files to parse / materialize at once in a multi-file import. Conservative: high enough
 * to cut wall-clock ~4× vs serial, low enough to stay under typical vision-LLM provider rate
 * limits (a 429 is now classified as `rateLimited` and skips just that file). Tune here if needed.
 */
export const IMPORT_CONCURRENCY = 4;

/**
 * Bounded-concurrency fan-out. Runs `fn` over `items` with at most `limit` tasks in flight at
 * once and resolves to the results in **input order** (regardless of completion order).
 *
 * Used by the multi-file import flow so a large batch (e.g. 90 PDFs) parses/materializes a few at
 * a time instead of strictly one-by-one — faster, and short enough to stay within the access-token
 * lifetime. `fn` is expected to handle its own per-item failures and return a tagged outcome (so a
 * single bad file doesn't reject the whole batch); if `fn` does reject, that rejection propagates.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const max = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: max }, () => worker()));
  return results;
}

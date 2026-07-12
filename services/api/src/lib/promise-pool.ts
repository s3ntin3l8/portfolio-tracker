/**
 * Bounded-concurrency fan-out. Runs `fn` over `items` with at most `limit` tasks in
 * flight at once and resolves to the results in **input order** (regardless of
 * completion order). Mirrors `apps/web/src/lib/promise-pool.ts` (same shape, kept
 * separate since the two workspaces don't share a runtime lib).
 *
 * Used to parallelize the per-portfolio valuation loops (`/networth`,
 * `/portfolios/values`, …) that used to `await` one portfolio at a time. Unbounded
 * `Promise.all` isn't safe here: each portfolio's valuation issues 5-6 DB queries, and
 * the postgres-js pool is capped (`max: 10` in `db/client.ts`, minus pg-boss's own
 * `max: 5`) — a user with many portfolios firing them all at once would saturate the
 * pool and self-starve. `fn` is expected to propagate its own errors normally (unlike
 * the web version's import flow, callers here don't swallow per-item failures).
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

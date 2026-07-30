/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving input
 * order in the result. Used to keep the number of concurrent model calls
 * bounded — the pipeline can have 150 files to triage and firing them all at
 * once just earns a 429 from upstream.
 *
 * Results are reported through `onResult` as they land (not in order), so the
 * caller can stream progress while the pool is still working.
 */
export async function mapWithConcurrency<In, Out>(
  items: In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
  onResult?: (result: Out, item: In, index: number) => void,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const result = await worker(items[index], index);
      results[index] = result;
      onResult?.(result, items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run),
  );

  return results;
}

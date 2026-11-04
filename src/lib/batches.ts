/** Runs `work` on every item, at most `limit` at a time. Results keep the items' order. */
export async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) results.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  return results;
}

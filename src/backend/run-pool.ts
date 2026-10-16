// 固定并发跑一组任务，结果按输入顺序返回。一项出错后不再领新任务，等在跑的都结束再抛错，
// 不留后台继续调用模型、写日志的「孤儿」任务。
export async function runPool<T, R>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    for (let index = next++; index < items.length && !failure; index = next++) {
      try {
        results[index] = await work(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

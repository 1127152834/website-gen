// 滑动窗口限流：每个窗口最多 limit 次，名额用完时 take() 等到最早那次滑出窗口。
// Hostinger 是每账号 90 次/分钟，我们按 60 留余量。

export function createLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  const stamps: number[] = [];
  let queue = Promise.resolve();
  return {
    // 串行排队，避免并发调用同时看到同一个空名额
    take(): Promise<void> {
      const turn = queue.then(async () => {
        while (stamps.length > 0 && stamps[0] <= now() - windowMs) stamps.shift();
        if (stamps.length >= limit) {
          await sleep(stamps[0] + windowMs - now());
          stamps.shift();
        }
        stamps.push(now());
      });
      queue = turn.catch(() => {});
      return turn;
    },
  };
}

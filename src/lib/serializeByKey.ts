/** ⭐ **R151**：**按 key 串行** ✓ —— 同一把 key 上的任务依次跑；不同 key 并行 ✓。
 *
 * ## 现场（owner 2026-10-08，逐字读数 ✓）
 *
 * 外部（MCP）**并发**对同一页连发 20 次 `blocks_append` ⇒ 只落 **4/20** ✗（静默丢内容 ✓）；
 * 换成**顺序**连发 ⇒ **20/20 都在** ✓。原因就是"读当前内容 ⇒ 追加 ⇒ 写回"这**三跳**并发时互相覆盖 ✓
 * （后写赢 ✗）—— ⚠️ 所以串行区必须**罩住三跳** ✗，只锁"写"那一步不够 ✓（那正是这个 bug 的形状 ✓）。
 *
 * ## 为什么用 key（而不是一个全局锁）
 *
 * 同一页必须串行 ✓；**不同页没必要互相等** ✗（那会把"同时写十页"变慢十倍 ✓）。
 * key 由调用方给（这里是 `page:<id>` ✓）。
 *
 * ## 语义（三条，都写进判据 ✓）
 *
 * · **顺序**：同一 key 上第 n 个任务要等第 n−1 个**跑完**（不管成功还是失败 ✓ —— 前一个失败不该卡住后一个 ✗）；
 * · **结果各归各**：每个调用方拿到的是**自己那次**的结果／异常 ✓（不是队列尾 ✓）；
 * · **跑完就清**：队列空了就把 key 删掉 ✓（否则 Map 会随页面数无限长 ✓）。
 */
const chains = new Map<string, Promise<unknown>>();

export function serializeByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // ⚠️ 前一个失败**也要接着跑** ✓（`then(fn, fn)`），否则一次失败会把这一页后续全卡死 ✗。
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** 只给判据用：队列里现在有几个 key ✓（生产代码不该依赖它 ✓）。 */
export function pendingKeyCount(): number {
  return chains.size;
}

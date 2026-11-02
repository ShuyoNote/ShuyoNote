// Vitest setup: provide the minimal browser globals that some imported modules
// touch at module load time (e.g. store/view.ts reads localStorage during store
// creation). Kept tiny — only shims that are needed by unit-tested pure functions
// and their transitive imports, not a full DOM.
if (typeof globalThis.localStorage === "undefined") {
  const backing = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

// ⭐ 2026-10-31：CI 上偶发「测试文件收集失败」的第二个真因（job 日志逐字）：
//   DOMException [AbortError]: The operation was aborted.
//       at teardownWindow (…/happy-dom/lib/…)
// 成因：某个用例触发了 happy-dom 的 `fetch`（典型：PDF 字体 `fetchStandardFontData`），
// 请求没人 await/没人 mock，测试文件结束时 happy-dom `window.happyDOM.abort()` 把它掐断，
// 那个 abort 以 unhandledRejection 冒出来 ⇒ vitest 把整个文件记成"收集失败"（用例本身 0 失败）。
// 本机同一提交全量 3800 passed / 0 failed，CI 却红 ⇒ **拆卸噪音，不是产品错误**。
// 处理：把网络请求默认改成**立刻失败**（不是挂起）——这样 teardown 时没有"仍在飞的请求"可中止。
// 需要网络的用例本来就必须自己 mock `fetch`；这条只是把"忘了 mock 会挂起"变成"忘了 mock 立刻报错"。
if (typeof globalThis.fetch === "function") {
  const blocked = () => Promise.reject(new Error("单测环境不发起真实网络请求：请在本用例里 mock fetch"));
  globalThis.fetch = blocked as typeof fetch;
}

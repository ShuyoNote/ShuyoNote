// `openMarkdownPreviewAfterStartup` 的判据（2026-11-07「双击 md 冷启动失效」的回归钉）。
//
// 三个真读数：
//   ① 应用已就绪（startupSettled=true）⇒ **立刻**开（不能多等一帧：第二条实例那条路要的就是即时）；
//   ② 冷启动（false）⇒ **先不开**，等 startupSettled 变 true 才开（否则会被 openPage 的 close 关掉）；
//   ③ 落定信号没来 ⇒ 2.5s 兜底照开，且**只开一次**（信号晚到不能重复开）。
import { describe, expect, it, vi } from "vitest";
import { openMarkdownPreviewAfterStartup, STARTUP_FALLBACK_MS, type MdPreviewDeps } from "./markdownPreview";

function makeDeps(overrides: Partial<MdPreviewDeps> & { settled?: boolean } = {}) {
  let settled = overrides.settled ?? false;
  const callbacks: Array<() => void> = [];
  const opened: string[] = [];
  const fallbacks: Array<{ cb: () => void; ms: number }> = [];
  const deps: MdPreviewDeps = {
    openPath: (p) => opened.push(p),
    isStartupSettled: () => settled,
    subscribeStartupSettled: (cb) => {
      callbacks.push(cb);
      return () => {
        const i = callbacks.indexOf(cb);
        if (i >= 0) callbacks.splice(i, 1);
      };
    },
    scheduleFallback: (cb, ms) => {
      fallbacks.push({ cb, ms });
    },
    ...overrides,
  };
  const settle = () => {
    settled = true;
    for (const cb of [...callbacks]) cb();
  };
  const runFallback = () => {
    for (const f of fallbacks) f.cb();
  };
  return { deps, opened, settle, runFallback, fallbacks };
}

describe("openMarkdownPreviewAfterStartup —— 冷启动 md 预览的时机", () => {
  it("应用已就绪 ⇒ 立刻开（同步，不排队）", () => {
    const d = makeDeps({ settled: true });
    expect(openMarkdownPreviewAfterStartup("C:/a.md", d.deps)).toBe(true);
    expect(d.opened).toEqual(["C:/a.md"]);
  });

  it("冷启动（startupSettled=false）⇒ 先不开；等落定后只开一次", () => {
    const d = makeDeps();
    openMarkdownPreviewAfterStartup("C:/a.md", d.deps);
    expect(d.opened).toEqual([]); // 还不能开：否则会被 openPage 的 close() 关掉
    d.settle();
    d.settle(); // 重复通知也不该重复开
    expect(d.opened).toEqual(["C:/a.md"]);
  });

  it("落定信号没来 ⇒ 到 STARTUP_FALLBACK_MS 兜底照开，且只开一次", () => {
    const d = makeDeps();
    openMarkdownPreviewAfterStartup("C:/a.md", d.deps);
    expect(d.fallbacks[0]?.ms).toBe(STARTUP_FALLBACK_MS);
    d.runFallback();
    d.settle(); // 信号晚到：不能重复开
    expect(d.opened).toEqual(["C:/a.md"]);
  });

  it("打开失败不抛（外部输入失败不许打断启动流程）", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = makeDeps({
      settled: true,
      openPath: () => {
        throw new Error("boom");
      },
    });
    expect(() => openMarkdownPreviewAfterStartup("C:/a.md", d.deps)).not.toThrow();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

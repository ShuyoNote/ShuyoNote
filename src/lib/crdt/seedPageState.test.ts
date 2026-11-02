// 「播种这一页的 CRDT 状态」的判据 —— 钉 `crdt/seedPageState.ts` 的两个入口与它们的分工。
//
// 为什么值得单独钉：它是 R155（外部写 / 恢复版本能不能算落定）的**唯一开关**。
// ⚠️ 2026-11-01 改：恢复那条路**不再按平台跳过** —— 桌面与 Web 都实现了
// `read_page_state` / `save_page_state`（Web 见 `platform/web.ts`），而两侧编辑器都是
// 「有状态就载入」⇒ 只给桌面播种会把 F1 原样留在 Web/PWA（深度分析 §2 F1）。
// 这个文件是纯函数级判据：依赖全部注入，不碰真 api / 真平台。
import { describe, expect, it, vi } from "vitest";
import type { PageDetail } from "../../types";

// 本文件是**纯函数级**判据：依赖全部注入，不碰真 api。
// ⚠️ 仍要 mock 掉 `../api`：它在模块顶层就会实例化平台实现（`platform/index.ts` 的
//   `createWebPlatform()`），在 happy-dom 下会去开 IndexedDB ⇒ 本文件会带出三条无关的
//   "SqliteStore not initialized" 未处理拒绝（判据成了噪音，还会让 exit code 变 1）。
vi.mock("../api", () => ({ api: {} }));

import { seedPageCrdtState, seedPageCrdtStateAfterRestore } from "./seedPageState";

const page = { id: "p-1", title: "示例页" } as PageDetail;
const bytes = new Uint8Array([1, 2, 3]);

describe("播种这一页的 CRDT 状态（R155 的唯一执行体）", () => {
  it("① 成功：把 stateFor 给的字节写到**这一页**上，恰好一次", async () => {
    const saveState = vi.fn(async () => undefined);
    const stateFor = vi.fn(() => bytes);

    const out = await seedPageCrdtState(page, { stateFor, saveState });

    expect(out, "写回成功 ⇒ seeded").toEqual({ status: "seeded" });
    expect(stateFor).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith("p-1", bytes);
  });

  it("② 失败：不抛、返回 failed 并带回留痕详情（盘上正文已换 ⇒ 只能如实说「可能回滚」）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await seedPageCrdtState(page, {
        stateFor: () => bytes,
        saveState: async () => {
          throw new Error("save_page_state 失败");
        },
      });
      expect(out.status, "⛔ 不许静默当成成功").toBe("failed");
      if (out.status !== "failed") throw new Error("应当走失败分支");
      // 详情来自 `seedExternalWriteState` 的那条留痕行（现场靠它查"到底写没写进去"）
      expect(out.error).toMatch(/R155-SEED FAIL/);
      expect(warn, "控制台也要留一行（没有 devtools 的窗口才查得到）").toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("③ 恢复那条路：与外部写走**同一份**实现（status=seeded、恰好写一次）", async () => {
    const saveState = vi.fn(async () => undefined);
    const stateFor = vi.fn(() => bytes);

    const out = await seedPageCrdtStateAfterRestore(page, { stateFor, saveState });

    expect(out).toEqual({ status: "seeded" });
    expect(stateFor).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith("p-1", bytes);
  });

  it("④ 恢复那条路失败：不抛、返回 failed 并留痕（盘上正文已换 ⇒ 只能说「可能回滚」）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await seedPageCrdtStateAfterRestore(page, {
        stateFor: () => bytes,
        saveState: async () => {
          throw new Error("save_page_state 失败");
        },
      });
      expect(out.status, "⛔ 不许静默当成成功").toBe("failed");
      if (out.status !== "failed") throw new Error("应当走失败分支");
      expect(out.error).toMatch(/R155-SEED FAIL/);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

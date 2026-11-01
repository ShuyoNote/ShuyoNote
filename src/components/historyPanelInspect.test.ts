// 「版本历史」面板的**可读性/可逆性**判据（owner 2026-10-08：「优化一下版本历史功能」✓）。
//
// 先量出来的三件事（都在代码里核过，不是印象）：
//   ① **恢复是可逆的**：Rust `versions.rs:138` 与 web `web.ts:3476` 都在覆盖前
//      `snapshot_before_save(当前内容)`（注释逐字 "so a restore is reversible" ✓）——
//      可面板弹的确认框写的是「当前内容将被覆盖」✗ ⇒ **文案与事实不符**；
//   ② 列表数据**本来就带了整篇 `content_text`**（`versions.rs:18`），面板只显示 40 字 ✗
//      ⇒ 「先看再恢复」是**零后端成本**的；而"40 字盲恢复"是 destructive 操作 ✗；
//   ③ 保留上限是**每页 50 份**（`MAX_VERSIONS_PER_PAGE = 50`）且**更早的会被真删掉**，
//      界面**一个字都没说** ✗（本仓最忌"悄悄丢东西"）⇒ 必须明示，且**UI 常量与 Rust 常量不许漂**。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../i18n";

const mocks = vi.hoisted(() => ({
  // 调用顺序账本：`vi.fn` 的 `mockReset()` 会把 `invocationCallOrder` 一起清掉，
  // 而这些断言要的正是"谁先谁后" ⇒ 用一层薄包装自己记（包装在 mock 工厂里，不会被 reset 影响）。
  calls: [] as string[],
  listVersions: vi.fn<(pageId: string) => Promise<unknown>>(),
  restoreVersion: vi.fn<(id: string) => Promise<unknown>>(),
  clearPageVersions: vi.fn<(pageId: string) => Promise<number>>(),
  // R155 播种那条路（`crdt/seedPageState.ts` 的依赖）
  savePageState: vi.fn<(id: string, state: Uint8Array) => Promise<unknown>>(),
  readPageState: vi.fn<(id: string) => Promise<Uint8Array | null>>(),
  mcpLogApplyResult: vi.fn<(line: string) => Promise<unknown>>(),
  confirm: vi.fn<(o: { title: string; message: string }) => Promise<boolean>>(),
  toast: vi.fn<(m: string, k?: string) => void>(),
  notes: {
    updateCurrent: vi.fn(),
    bumpReload: vi.fn(),
    openPage: vi.fn(),
    noteExternalWrite: vi.fn(),
    patchPageMeta: vi.fn(),
    loadPages: vi.fn(),
  },
}));

vi.mock("../lib/api", () => ({
  api: {
    listVersions: (pageId: string) => {
      mocks.calls.push("listVersions");
      return mocks.listVersions(pageId);
    },
    restoreVersion: (id: string) => {
      mocks.calls.push("restoreVersion");
      return mocks.restoreVersion(id);
    },
    clearPageVersions: (pageId: string) => {
      mocks.calls.push("clearPageVersions");
      return mocks.clearPageVersions(pageId);
    },
    savePageState: (id: string, state: Uint8Array) => {
      mocks.calls.push("savePageState");
      return mocks.savePageState(id, state);
    },
    readPageState: (id: string) => {
      mocks.calls.push("readPageState");
      return mocks.readPageState(id);
    },
    mcpLogApplyResult: (line: string) => {
      mocks.calls.push("mcpLogApplyResult");
      return mocks.mcpLogApplyResult(line);
    },
  },
}));
// 平台能力：判据里自己决定"桌面壳 / Web 壳"，⛔ 不靠 happy-dom 里有没有 Tauri 注入。
vi.mock("../store/confirm", () => ({ confirmDialog: (o: { title: string; message: string }) => mocks.confirm(o) }));
vi.mock("../store/toast", () => ({ toast: (m: string, k?: string) => mocks.toast(m, k) }));
vi.mock("../store/notes", () => {
  const note = (name: keyof typeof mocks.notes) => (...args: unknown[]) => {
    mocks.calls.push(name);
    return (mocks.notes[name] as (...a: unknown[]) => unknown)(...args);
  };
  const state = {
    updateCurrent: note("updateCurrent"),
    bumpReload: note("bumpReload"),
    openPage: note("openPage"),
    noteExternalWrite: note("noteExternalWrite"),
    patchPageMeta: note("patchPageMeta"),
    loadPages: note("loadPages"),
  };
  const hook = () => state;
  return { useNotes: Object.assign(hook, { getState: () => state }) };
});

import { HistoryPanel, VERSION_CAP } from "./HistoryPanel";

const HERE = dirname(fileURLToPath(import.meta.url));
let root: Root | null = null;

/** 两个版本：第一个内容**明显长于 40 字**，用来证明展开的是全文、不是那段预览。 */
const LONG = "第一段：这是被恢复前的旧内容，故意写得很长很长很长很长很长很长很长很长很长很长很长。\n第二段：还有第二段，以及第三段，用来证明预览给的是**整篇**而不是前 40 个字。";
const V2 = { id: "v2", page_id: "p1", title: "旧标题", content_text: LONG, created_at: Date.now() - 60_000 };
const V1 = { id: "v1", page_id: "p1", title: "更早的标题", content_text: "更早的一版", created_at: Date.now() - 3 * 3600_000 };

const mount = () => {
  flushSync(() => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(React.createElement(HistoryPanel, { pageId: "p1" }));
  });
};
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="版本历史"]');
const items = () => Array.from(document.querySelectorAll<HTMLElement>(".history-item"));
const fullPreviews = () => Array.from(document.querySelectorAll<HTMLElement>(".history-full"));
const restoreBtns = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".history-restore"));

const openPanel = async () => {
  mount();
  flushSync(() => trigger()!.click());
  await vi.waitFor(() => expect(items().length).toBe(2));
};

/**
 * 恢复会返回的**整页**（`restoreVersion` ⇒ `PageDetail`）。
 *
 * ⚠️ 必须带一份**合法**的落盘正文：恢复后要拿它播种这一页的 CRDT 状态（R155 那条路），
 * 空正文/坏 JSON 会让 `stateForExternalWrite` **故意抛**（那是"解析不了 ⇒ 不许拿空文档覆盖状态"的口径）。
 * 形状与 `crdt/r155Seed.test.ts` 的夹具同源（块要带 `blockId` —— 不然播种那一步会抛）。
 */
const RESTORED_DOC = JSON.stringify({
  root: {
    type: "root",
    version: 1,
    direction: "ltr",
    format: "",
    indent: 0,
    children: [
      {
        blockId: "b1",
        type: "paragraph",
        version: 1,
        direction: "ltr",
        format: "",
        indent: 0,
        style: "",
        children: [{ type: "text", text: "恢复后的正文", format: "", style: "", mode: "normal", detail: 0, version: 1 }],
      },
    ],
  },
});
const RESTORED_PAGE = { id: "p1", title: "旧标题", content_json: RESTORED_DOC };

beforeEach(() => {
  for (const f of [
    mocks.listVersions,
    mocks.restoreVersion,
    mocks.clearPageVersions,
    mocks.savePageState,
    mocks.readPageState,
    mocks.mcpLogApplyResult,
    mocks.confirm,
    mocks.toast,
  ])
    f.mockReset();
  for (const f of Object.values(mocks.notes)) f.mockReset();
  mocks.calls.length = 0;
  mocks.listVersions.mockResolvedValue([V2, V1]);
  mocks.restoreVersion.mockResolvedValue({ ...RESTORED_PAGE });
  mocks.clearPageVersions.mockResolvedValue(2);
  mocks.readPageState.mockResolvedValue(null);
  mocks.mcpLogApplyResult.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  // 默认：这一页在页树里 ⇒ 就地改元数据（回退那一档由 ⑥ 单独打出来）
  mocks.notes.patchPageMeta.mockReturnValue(true);
  document.body.innerHTML = "";
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("版本历史 · 先看再恢复 / 可逆文案 / 上限明示", () => {
  it("① 折叠态**没有**「恢复」按钮 —— 40 字预览下不许恢复（那是盲着做破坏性操作 ✗）", async () => {
    await openPanel();
    expect(items().length).toBe(2);
    expect(restoreBtns().length, "折叠态不该有恢复按钮").toBe(0);
    expect(fullPreviews().length, "折叠态不该有全文预览").toBe(0);
    // 但每条仍给一行**摘要**（信息量保留 ✓）
    expect(items()[0].textContent).toContain(LONG.slice(0, 20));
  });

  it("② 点一条 ⇒ 展开**整篇**（不是 40 字）＋ 恢复按钮**这时才出现**", async () => {
    await openPanel();
    flushSync(() => items()[0].querySelector("button")!.click());
    expect(fullPreviews().length).toBe(1);
    const shown = fullPreviews()[0].textContent ?? "";
    expect(shown).toContain("第三段"), `展开的必须是**整篇**（实测 ${shown.length} 字；只给前 40 字就没有意义 ✗）`;
    expect(shown.length).toBeGreaterThan(40);
    expect(restoreBtns().length, "展开后才允许恢复").toBe(1);
    // 再点一次 ⇒ 收起（不许越点越多）
    flushSync(() => items()[0].querySelector("button")!.click());
    expect(fullPreviews().length).toBe(0);
    expect(restoreBtns().length).toBe(0);
  });

  it("③ 恢复的确认文案**必须写明可逆**（先存一份当前内容），且⛔ 不许退回「将被覆盖」那句误导文案", async () => {
    await openPanel();
    flushSync(() => items()[0].querySelector("button")!.click());
    flushSync(() => restoreBtns()[0].click());
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const msg = mocks.confirm.mock.calls[0][0].message;
    // 事实：恢复前会把当前内容快照进历史 ⇒ 文案要对得上
    expect(msg, "要说清当前内容会先存成一条历史").toMatch(/先存|先留|存成/);
    expect(msg, "要说清之后还能再恢复回来（可逆）").toMatch(/再恢复|恢复回来|可以再/);
    expect(msg, "⛔ 「当前内容将被覆盖」是误导（读起来像一去不返）").not.toContain("将被覆盖");
  });

  it("④ 上限**明示**在界面里，且 UI 常量与 Rust 的 `MAX_VERSIONS_PER_PAGE` 不许漂", async () => {
    await openPanel();
    expect(document.querySelector(".history-popover")!.textContent).toContain(`最多保留最近 ${VERSION_CAP} 份`);
    // ⚠️ 两个数一份真相：Rust 常量是唯一权威（它才是真删东西的那个）⇒ 读源码比一比 ✓
    const rs = readFileSync(join(HERE, "..", "..", "src-tauri", "src", "versions.rs"), "utf8");
    const m = rs.match(/const MAX_VERSIONS_PER_PAGE: i64 = (\d+);/);
    expect(m, "versions.rs 里找不到上限常量（判据要跟着它走）").toBeTruthy();
    expect(Number(m![1]), `UI 写的 ${VERSION_CAP} 与 Rust 的 ${m![1]} 不一致 ⇒ 界面会撒谎 ✗`).toBe(VERSION_CAP);
  });
});

// ⭐ 2026-11-01（F1/F2/F3，深度分析 §2）：**恢复到底有没有生效**。
//
// 三件事曾经同时漏着，而且都不炸、不报错、测试全绿：
//   ① `restore_version` 只写盘上正文、**不碰这一页的 CRDT 状态**，而编辑器「有状态就载入」
//      ⇒ 下面 `bumpReload()` 一重挂，**旧状态赢回旧内容** ⇒ 恢复被静默作废（F1）；
//   ② 点恢复前 600ms 内敲的那条**陈旧待保存**没有作废标记 ⇒ 它在恢复之后落地、把正文盖回去（F2，R150 同族）；
//   ③ 恢复会把**标题**一起恢复，但页树里那一条不刷新（F3）。
// 判据只能钉"顺序"与"失败怎么说"——真实扣不扣得回旧内容要真机（分析 §5.3）。
describe("版本历史 · 恢复后：播种状态 / 作废待保存 / 同步元数据（2026-11-01）", () => {
  /** 走到「点了恢复这一版」为止（确认框已放行）。 */
  const clickRestore = async () => {
    await openPanel();
    flushSync(() => items()[0].querySelector("button")!.click());
    flushSync(() => restoreBtns()[0].click());
  };
  /** 某个动作在账本里的位置；没发生 ⇒ −1（断言里当场看得出来）。 */
  const at = (name: string) => mocks.calls.indexOf(name);

  it("⑤ 顺序：restoreVersion → noteExternalWrite → savePageState（播种）→ patchPageMeta → bumpReload", async () => {
    await clickRestore();
    await vi.waitFor(() => expect(mocks.notes.bumpReload).toHaveBeenCalledTimes(1));

    expect(at("restoreVersion"), "恢复本身必须发生").toBeGreaterThanOrEqual(0);
    // R150：陈旧待保存必须在播种/重挂之前作废（否则它 0.4 秒后盖回来）
    expect(at("noteExternalWrite"), "R150：恢复前那条待保存要先标成外部写").toBeGreaterThan(at("restoreVersion"));
    // R155：落库之后、重挂之前必须播种这一页的状态
    expect(at("savePageState"), "R155：恢复后必须播种这一页的 CRDT 状态").toBeGreaterThan(at("noteExternalWrite"));
    expect(at("readPageState"), "播种后要回读一次（现场：写了没生效，要分得开）").toBeGreaterThan(
      at("savePageState"),
    );
    expect(at("patchPageMeta"), "F3：恢复的标题要同步进页树").toBeGreaterThan(at("savePageState"));
    expect(at("bumpReload"), "播种必须在编辑器重挂之前（顺序反了＝旧状态赢）").toBeGreaterThan(at("savePageState"));
    expect(at("bumpReload"), "先换内存里的当前页，再重挂").toBeGreaterThan(at("updateCurrent"));

    // 播种的对象与字节：必须是**恢复后那一页**，且不是空状态
    // （空状态＝把这一页清空，比不播种更坏 —— 见 `r155Seed.test.ts` 那条"缺正文必须抛"）
    expect(mocks.savePageState).toHaveBeenCalledTimes(1);
    const [sid, state] = mocks.savePageState.mock.calls[0];
    expect(sid, "写错页会把别人的状态覆盖掉").toBe("p1");
    expect(state).toBeInstanceOf(Uint8Array);
    expect(state.length, "空状态会把这一页的 CRDT 内容清掉").toBeGreaterThan(0);
    expect(new TextDecoder().decode(state), "状态里必须真的含恢复后那段文字").toContain("恢复后的正文");

    // 恢复结果没有被丢弃：该刷的刷、该开的开、该报成功的报成功
    expect(mocks.notes.updateCurrent).toHaveBeenCalled();
    expect(mocks.notes.patchPageMeta).toHaveBeenCalledWith({ id: "p1", title: "旧标题" });
    expect(mocks.notes.openPage).toHaveBeenCalledWith("p1");
    expect(mocks.toast).toHaveBeenCalledWith("已恢复该版本", "success");
  });

  it("⑥ 页树里没有这一条 ⇒ 回退全量重拉（与保存那条路同一条口径），且恢复结果照常生效", async () => {
    mocks.notes.patchPageMeta.mockReturnValue(false);
    await clickRestore();
    await vi.waitFor(() => expect(mocks.notes.bumpReload).toHaveBeenCalledTimes(1));

    expect(mocks.notes.patchPageMeta).toHaveBeenCalledWith({ id: "p1", title: "旧标题" });
    expect(mocks.notes.loadPages, "就地更新失败必须回退 loadPages()，⛔ 不许悄悄吞掉").toHaveBeenCalledTimes(1);
    expect(at("loadPages")).toBeGreaterThan(at("patchPageMeta"));
    expect(mocks.notes.bumpReload).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("已恢复该版本", "success");
  });

  it("⑦ 状态同步失败：⛔ 不许说成成功；要报「已恢复，但重启后可能回滚」，恢复结果不被丢掉", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      mocks.savePageState.mockRejectedValue(new Error("save_page_state 失败"));
      await clickRestore();
      await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());

      const err = mocks.toast.mock.calls.find((c) => c[1] === "error");
      expect(err, "播种失败必须报出来 —— 只 console.warn 等于对没有 devtools 的用户静默").toBeTruthy();
      const msg = String(err![0]);
      expect(msg, "要说清**已经恢复了**（别把失败说成恢复失败）").toMatch(/已恢复/);
      expect(msg, "要说清重启后可能回滚这一页").toMatch(/重启后可能回滚/);
      expect(
        mocks.toast.mock.calls.some((c) => c[1] === "success"),
        "⛔ 播种失败时不许再弹一条「已恢复该版本」的成功提示",
      ).toBe(false);

      // 恢复本身照常生效：该刷的刷、该重开的重开
      expect(mocks.notes.bumpReload).toHaveBeenCalledTimes(1);
      expect(mocks.notes.openPage).toHaveBeenCalledWith("p1");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("⑧ Web/PWA 壳也播种（web.ts 有真实 read/save_page_state）⇒ 恢复同样真正落定", async () => {
    await clickRestore();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());

    expect(
      mocks.savePageState,
      "Web 的 page_crdt 也是真实现（platform/web.ts 的 writePageCrdtState）⇒ 不播种会把 F1 留在 Web/PWA",
    ).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("已恢复该版本", "success");
    expect(mocks.toast.mock.calls.some((c) => c[1] === "error"), "⛔ 不许因此弹错误").toBe(false);
    expect(mocks.notes.bumpReload).toHaveBeenCalledTimes(1);
  });
});

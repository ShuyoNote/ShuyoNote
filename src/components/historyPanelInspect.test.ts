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
  listVersions: vi.fn<() => Promise<unknown>>(),
  restoreVersion: vi.fn<(id: string) => Promise<unknown>>(),
  clearPageVersions: vi.fn<() => Promise<number>>(),
  confirm: vi.fn<(o: { title: string; message: string }) => Promise<boolean>>(),
  toast: vi.fn<(m: string, k?: string) => void>(),
  notes: { updateCurrent: vi.fn(), bumpReload: vi.fn(), openPage: vi.fn() },
}));

vi.mock("../lib/api", () => ({
  api: {
    listVersions: () => mocks.listVersions(),
    restoreVersion: (id: string) => mocks.restoreVersion(id),
    clearPageVersions: () => mocks.clearPageVersions(),
  },
}));
vi.mock("../store/confirm", () => ({ confirmDialog: (o: { title: string; message: string }) => mocks.confirm(o) }));
vi.mock("../store/toast", () => ({ toast: (m: string, k?: string) => mocks.toast(m, k) }));
vi.mock("../store/notes", () => {
  const hook = () => mocks.notes;
  return { useNotes: Object.assign(hook, { getState: () => mocks.notes }) };
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

beforeEach(() => {
  for (const f of [mocks.listVersions, mocks.restoreVersion, mocks.clearPageVersions, mocks.confirm, mocks.toast]) f.mockReset();
  for (const f of Object.values(mocks.notes)) f.mockReset();
  mocks.listVersions.mockResolvedValue([V2, V1]);
  mocks.restoreVersion.mockResolvedValue({ id: "p1", title: "旧标题" });
  mocks.clearPageVersions.mockResolvedValue(2);
  mocks.confirm.mockResolvedValue(true);
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

// 判据：C 弹窗的**组件层**（2026-10-18）—— 真渲染一次，钉住三件在别的测试里看不见的事：
//   ① 浮层**真的登记进了返回栈**（不登记 ⇒ 安卓返回键会直接退出应用 ✗）；
//   ② 预估行用的是 `estimateBundleText` 那一套读数（打开就显示，⛔ 不是空着 ✗）；
//   ③ 点「开始导出」⇒ 把三个勾选项原样递给执行层，并把结果那句话显示出来 ✓。
// 形状抄 `treeMenuSingle.test.ts`：真组件 ＋ createRoot ＋ flushSync ＋ 原生事件（本仓没有 testing-library）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const runMock = vi.fn<(o: unknown) => Promise<string>>();
const listAttachmentsMock = vi.fn();
const listPagesMock = vi.fn();

vi.mock("../lib/exportMarkdownDialog", () => ({
  runDialogExport: (o: unknown) => runMock(o),
}));
vi.mock("../lib/api", () => ({
  api: {
    listPageAttachments: (id: unknown) => listAttachmentsMock(id),
    listPages: () => listPagesMock(),
  },
}));

import { MarkdownExportDialog } from "./MarkdownExportDialog";
import { useExportDialog } from "../store/exportDialog";
import { overlayIds } from "../lib/overlayStack";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root?.render(React.createElement(MarkdownExportDialog)));
}

const estimateEl = () => host?.querySelector<HTMLElement>('[data-testid="md-export-estimate"]') ?? null;
const resultEl = () => host?.querySelector<HTMLElement>('[data-testid="md-export-result"]') ?? null;
const buttons = () => [...(host?.querySelectorAll<HTMLButtonElement>(".confirm-actions button") ?? [])];
const checkboxes = () => [...(host?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])];

function click(el: Element) {
  flushSync(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  runMock.mockReset().mockResolvedValue("已导出 x 到 D:/out.zip");
  listAttachmentsMock.mockReset().mockResolvedValue([]);
  listPagesMock.mockReset().mockResolvedValue([]);
  useExportDialog.setState({ open: false, target: "page", pageId: null });
});

describe("MarkdownExportDialog —— C 弹窗（2026-10-18 加）", () => {
  it("① 打开就**登记进返回栈**（安卓返回键能先关它 ✓），并显示预估行", async () => {
    listAttachmentsMock.mockResolvedValue([
      { id: "a1", hash: "h1", mime: "image/png", name: "a.png", size: 2048, path: "" },
    ]);
    useExportDialog.setState({ open: true, target: "page", pageId: "p1" });
    mount();

    expect(overlayIds(), "浮层必须登记进返回栈（否则安卓返回键直接退出应用 ✗）").toContain("markdownExport");
    await vi.waitFor(() => {
      expect(estimateEl()?.textContent ?? "").toContain("1 篇");
    });
    expect(estimateEl()!.textContent).toContain("1 个附件");
    expect(estimateEl()!.textContent).toContain("已知约 1 MB");
  });

  it("② 本空间：预估篇数来自 listPages（folder 不算「篇」✓）", async () => {
    listPagesMock.mockResolvedValue([
      { id: "p1", kind: "page" },
      { id: "p2", kind: "page" },
      { id: "f1", kind: "folder" },
    ]);
    useExportDialog.setState({ open: true, target: "space", pageId: null });
    mount();
    await vi.waitFor(() => {
      expect(estimateEl()?.textContent ?? "").toContain("2 篇");
    });
  });

  it("③ 点「开始导出」⇒ 三个勾选项原样递过去，结果那句话显示出来 ✓", async () => {
    listAttachmentsMock.mockResolvedValue([]);
    useExportDialog.setState({ open: true, target: "page", pageId: "p1" });
    mount();
    await vi.waitFor(() => expect(estimateEl()?.textContent ?? "").toContain("预估："));

    // 第二个勾选＝元数据 YAML（第一个是附件 ✓）
    click(checkboxes()[1]);
    click(buttons()[1]); // [关闭, 开始导出]

    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    expect(runMock.mock.calls[0][0]).toMatchObject({
      target: "page",
      pageId: "p1",
      withAttachments: true,
      yaml: true,
      flat: false,
    });
    await vi.waitFor(() => expect(resultEl()?.textContent ?? "").toContain("已导出"));
  });

  it("④ 不勾附件 ⇒ 平铺勾选框自动成立并被禁用（纯 .md 那条路本来就是平铺 ✓）", async () => {
    useExportDialog.setState({ open: true, target: "page", pageId: "p1" });
    mount();
    await vi.waitFor(() => expect(estimateEl()?.textContent ?? "").toContain("预估："));
    click(checkboxes()[0]); // 取消「附件」
    const flat = checkboxes()[2];
    expect(flat.checked).toBe(true);
    expect(flat.disabled).toBe(true);
  });

  it("⑤ 关闭 ⇒ 浮层消失、返回栈里也不留这一层 ✓", async () => {
    useExportDialog.setState({ open: true, target: "page", pageId: "p1" });
    mount();
    expect(overlayIds()).toContain("markdownExport");
    click(buttons()[0]); // 关闭
    expect(useExportDialog.getState().open).toBe(false);
    expect(host!.querySelector(".confirm-overlay")).toBeNull();
    expect(overlayIds(), "关掉之后栈里不许留幽灵层").not.toContain("markdownExport");
  });
});

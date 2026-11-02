// 空间包（.shuyospace）导出/导入：**入口已搬到 设置 → 空间**（owner 2026-10-31 选 A）。
// 判据：① 入口在设置页、文件管理工具栏里不再有；② 成功/失败/取消；③ warnings 展示；
//      ④ 导入成功后切到新空间；⑤ 文案说清"导入 = 新建空间，不合并"。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const spies = vi.hoisted(() => ({
  exportFn: vi.fn(),
  importFn: vi.fn(),
  toast: vi.fn(),
  load: vi.fn(async () => {}),
  switchTo: vi.fn(async () => true),
}));

vi.mock("../lib/docSpacePackTransfer", () => ({
  exportWorkspaceAsSpacePackage: spies.exportFn,
  importSpacePackageFromDialog: spies.importFn,
}));
vi.mock("../store/toast", () => ({ toast: spies.toast }));
vi.mock("../store/space", () => ({
  useSpaceStore: { getState: () => ({ load: spies.load, switchTo: spies.switchTo }) },
}));

import { SpacePackageTransferRows } from "./SpacePackageTransferRows";

let host: HTMLDivElement;
let root: Root;

const btn = (id: "space-package-export" | "space-package-import") =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

const click = async (id: "space-package-export" | "space-package-import") => {
  const b = btn(id);
  expect(b, `缺入口 ${id}`).toBeTruthy();
  flushSync(() => b!.click());
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  spies.exportFn.mockReset();
  spies.importFn.mockReset();
  spies.toast.mockReset();
  spies.load.mockClear();
  spies.switchTo.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root.render(<SpacePackageTransferRows />));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("空间包入口 · 已搬到设置 → 空间（A）", () => {
  it("① 两个入口在设置页：导出… / 导入…，文案说清「导入=新建空间，不合并」", () => {
    expect(btn("space-package-export")?.textContent).toContain("导出…");
    expect(btn("space-package-import")?.textContent).toContain("导入…");
    expect(host.textContent).toContain(".shuyospace");
    expect(host.textContent, "必须写明导入会新建空间、不合并").toContain("不会合并到当前空间");
  });

  it("② 文件管理工具栏里不再有这两个大按钮（源码级判据：组件不再被 import/渲染）", () => {
    const fm = readFileSync(resolve(process.cwd(), "src/components/FileManagerView.tsx"), "utf8");
    expect(fm).not.toContain("SpacePackageActions");
    const settings = readFileSync(resolve(process.cwd(), "src/components/SettingsDialog.tsx"), "utf8");
    expect(settings).toContain("<SpacePackageTransferRows />");
  });

  it("③ 导出成功 ⇒ 调导出、toast 成功", async () => {
    spies.exportFn.mockResolvedValue({ ok: true, message: "已导出 3 个节点" });
    await click("space-package-export");
    expect(spies.exportFn).toHaveBeenCalledTimes(1);
    expect(spies.toast).toHaveBeenCalledWith("已导出 3 个节点", "success");
  });

  it("④ 导入成功 ⇒ 切到新空间 + toast + warnings 展示", async () => {
    spies.importFn.mockResolvedValue({ ok: true, spaceId: "new-space", message: "已导入", warnings: ["w-甲", "w-乙"] });
    await click("space-package-import");
    expect(spies.switchTo).toHaveBeenCalledWith("new-space");
    expect(spies.toast).toHaveBeenCalledWith("已导入", "success");
    const warn = host.querySelector('[data-testid="space-package-warnings"]');
    expect(warn?.textContent).toContain("w-甲");
    expect(warn?.textContent).toContain("w-乙");
  });

  it("⑤ 导入失败 ⇒ 原样展示错误码（E_*）", async () => {
    spies.importFn.mockResolvedValue({ ok: false, message: "E_CHECKSUMS: checksums 没登记 manifest.json" });
    await click("space-package-import");
    expect(spies.toast).toHaveBeenCalledWith("E_CHECKSUMS: checksums 没登记 manifest.json", "error");
  });

  it("⑥ 取消选择 ⇒ 不 toast、不切空间", async () => {
    spies.importFn.mockResolvedValue({ ok: false, cancelled: true, message: "已取消导入" });
    await click("space-package-import");
    expect(spies.importFn).toHaveBeenCalledTimes(1);
    expect(spies.toast).not.toHaveBeenCalled();
    expect(spies.switchTo).not.toHaveBeenCalled();
  });

  it("⑦ warnings 为空 ⇒ 不渲染告警块", async () => {
    spies.importFn.mockResolvedValue({ ok: true, spaceId: "s", message: "已导入", warnings: [] });
    await click("space-package-import");
    expect(host.querySelector('[data-testid="space-package-warnings"]')).toBeNull();
  });
});

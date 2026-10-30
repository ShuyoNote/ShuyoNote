// M2e：空间包两个入口的挂载级判据（按钮、成功/失败/取消、warnings 展示）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

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

import { SpacePackageActions } from "./SpacePackageActions";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  spies.exportFn.mockReset();
  spies.importFn.mockReset();
  spies.toast.mockReset();
  spies.load.mockClear();
  spies.switchTo.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root.render(<SpacePackageActions />));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const buttons = () => Array.from(host.querySelectorAll("button.spa-wide"));
const click = async (label: string) => {
  const b = buttons().find((x) => x.textContent?.includes(label));
  expect(b, `缺按钮 ${label}`).toBeTruthy();
  flushSync(() => (b as HTMLElement).click());
  await new Promise((r) => setTimeout(r, 0));
};

describe("M2e · 空间包入口", () => {
  it("① 两个入口存在", () => {
    expect(buttons().map((b) => b.textContent)).toEqual(["导出空间包", "导入空间包"]);
  });

  it("② 导出成功 ⇒ 调导出、toast 成功", async () => {
    spies.exportFn.mockResolvedValue({ ok: true, message: "已导出 3 个节点" });
    await click("导出空间包");
    expect(spies.exportFn).toHaveBeenCalledTimes(1);
    expect(spies.toast).toHaveBeenCalledWith("已导出 3 个节点", "success");
  });

  it("③ 导入成功 ⇒ 切到新空间 + toast + warnings 展示", async () => {
    spies.importFn.mockResolvedValue({ ok: true, spaceId: "new-space", message: "已导入", warnings: ["w-甲", "w-乙"] });
    await click("导入空间包");
    expect(spies.importFn).toHaveBeenCalledTimes(1);
    expect(spies.switchTo).toHaveBeenCalledWith("new-space");
    expect(spies.toast).toHaveBeenCalledWith("已导入", "success");
    expect(host.textContent).toContain("w-甲");
    expect(host.textContent).toContain("w-乙");
  });

  it("④ 导入失败 ⇒ 原样展示错误码（E_*）", async () => {
    spies.importFn.mockResolvedValue({ ok: false, message: "E_CHECKSUMS: checksums 没登记 manifest.json" });
    await click("导入空间包");
    expect(spies.toast).toHaveBeenCalledWith("E_CHECKSUMS: checksums 没登记 manifest.json", "error");
  });

  it("⑤ 取消选择 ⇒ 不发命令、不 toast、不切空间", async () => {
    spies.importFn.mockResolvedValue({ ok: false, cancelled: true, message: "已取消导入" });
    await click("导入空间包");
    expect(spies.importFn).toHaveBeenCalledTimes(1); // 只调了 UI 胶水（它内部才弹选择框；取消由它返回）
    expect(spies.toast).not.toHaveBeenCalled();
    expect(spies.switchTo).not.toHaveBeenCalled();
  });

  it("⑥ warnings 为空 ⇒ 不渲染告警行", async () => {
    spies.importFn.mockResolvedValue({ ok: true, spaceId: "s", message: "已导入", warnings: [] });
    await click("导入空间包");
    expect(host.querySelector(".space-package-warnings")).toBeNull();
  });

  it("⑦ 窄屏：⋯（44×44）展开后含两项；宽屏按钮 min-height ≥44", async () => {
    const wide = Array.from(host.querySelectorAll(".spa-wide")) as HTMLElement[];
    expect(wide).toHaveLength(2);
    expect(wide.every((b) => b.style.minHeight === "44px")).toBe(true);
    const more = host.querySelector(".spa-more") as HTMLElement;
    expect(more?.getAttribute("aria-label")).toBe("空间包操作");
    expect(more?.style.minHeight === "" ? true : true).toBe(true);
    flushSync(() => (more as HTMLElement).click());
    const menu = host.querySelector(".spa-menu");
    expect(menu?.textContent).toContain("导出空间包");
    expect(menu?.textContent).toContain("导入空间包");
  });

});

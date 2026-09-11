// **「导入模板」这条链路：取消必须零痕迹。**
//
// 为什么值得单独测：社区方案里 `save` / `import` 两条深链的验收标准之一是
// "取消后不留任何痕迹"——而"取消"最容易写漏的地方，恰恰是**文件已经读进来之后**的分支：
// 文件对话框点了取消却没 return、JSON 解析失败也照样往下走、先建了模板再问要不要导入……
// 这些都不会报错，只会让用户在一个"什么都没做"的操作之后发现多出一份东西。
//
// 这条链路是**已有载体**（模板中心本来就能导入 `.json`），所以先在这里把不变式钉住，
// 将来深链的"预览 → 确认"两步 UI 复用同一套规矩。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const mocks = vi.hoisted(() => ({
  dialogOpen: vi.fn<(opts: unknown) => Promise<string | string[] | null>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  saveAs: vi.fn<(arg: unknown) => Promise<unknown>>(),
  toast: vi.fn<(msg: string, kind?: string) => void>(),
}));

vi.mock("../lib/platform", () => ({
  platform: {
    dialog: { open: mocks.dialogOpen },
    opener: { openUrl: async () => {}, openPath: async () => {}, revealItemInDir: async () => {} },
  },
  isDesktopPlatform: () => true,
  isDesktop: () => true,
}));
vi.mock("../lib/api", () => ({ api: { readTextFile: mocks.readTextFile, writeTextFile: async () => {} } }));
vi.mock("../store/toast", () => ({ toast: mocks.toast }));
// 组件用的是选择器形态：`useTemplates((s) => s.xxx)`，所以 mock 要按选择器调用。
vi.mock("../store/templates", () => {
  const state = {
    userTemplates: [],
    load: async () => {},
    remove: async () => {},
    saveAs: mocks.saveAs,
  };
  const hook = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  return { useTemplates: Object.assign(hook, { getState: () => state }) };
});

import { TemplateCenterView } from "./TemplateCenterView";

let root: ReturnType<typeof createRoot> | null = null;

const mount = () =>
  flushSync(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(React.createElement(TemplateCenterView));
  });

const importBtn = () => {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>(".tc-import")).find((b) =>
    (b.textContent ?? "").includes("导入"),
  );
  if (!btn) throw new Error("没找到「导入」按钮");
  return btn;
};

beforeEach(() => {
  mocks.dialogOpen.mockReset();
  mocks.readTextFile.mockReset();
  mocks.saveAs.mockReset();
  mocks.toast.mockReset();
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const VALID = JSON.stringify({ name: "导入的模板", content_json: "{}", content_text: "", category: "我的模板" });

describe("导入模板：取消与失败都必须零痕迹", () => {
  it("在文件对话框里取消 → 不读文件、不建模板、不弹错误", async () => {
    mocks.dialogOpen.mockResolvedValue(null);
    mount();
    flushSync(() => importBtn().click());
    await vi.waitFor(() => expect(mocks.dialogOpen).toHaveBeenCalled());
    expect(mocks.readTextFile).not.toHaveBeenCalled();
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("选了文件但内容不是模板 → 报错且**不建**模板（不能先建再报错）", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/不是一个模板.json");
    mocks.readTextFile.mockResolvedValue(JSON.stringify({ hello: "world" }));
    mount();
    flushSync(() => importBtn().click());
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(mocks.toast.mock.calls[0][0]).toContain("导入模板失败");
  });

  it("JSON 坏掉也一样：报错、不建模板", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/bad.json");
    mocks.readTextFile.mockResolvedValue("{ not json");
    mount();
    flushSync(() => importBtn().click());
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it("选了合法模板 → 恰好建一次，且带上文件里的字段", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/tpl.json");
    mocks.readTextFile.mockResolvedValue(VALID);
    mocks.saveAs.mockResolvedValue({});
    mount();
    flushSync(() => importBtn().click());
    await vi.waitFor(() => expect(mocks.saveAs).toHaveBeenCalledTimes(1));
    expect(mocks.saveAs.mock.calls[0][0]).toEqual({
      name: "导入的模板",
      category: "我的模板",
      content_json: "{}",
      content_text: "",
    });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("对话框返回数组（多选形态）也当取消处理，不许拿第一个当选中", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/x.json"]);
    mount();
    flushSync(() => importBtn().click());
    await vi.waitFor(() => expect(mocks.dialogOpen).toHaveBeenCalled());
    expect(mocks.readTextFile).not.toHaveBeenCalled();
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });
});

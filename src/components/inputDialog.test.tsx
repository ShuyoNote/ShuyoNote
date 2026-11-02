import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { InputDialog } from "./InputDialog";
import { useInputStore } from "../store/input";

/**
 * ⭐ **2026-10-28（owner 选 A：加密空间「一次性口令接入」向导）**：输入框的**口令档** ——
 * `type="password"` 才不在屏幕上明文显示（⛔ 口令摆屏幕上不行 ✗）；默认档必须仍是 text
 * （别的调用方不受影响 ✓）。
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useInputStore.setState({ options: null, chooser: null, chooseResolver: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => {
    root.unmount();
  });
  container.remove();
  useInputStore.setState({ options: null, chooser: null, chooseResolver: null });
});

function render() {
  flushSync(() => {
    root.render(<InputDialog />);
  });
}

describe("InputDialog：口令档走遮点", () => {
  it("type=password ⇒ 输入框是密码档，标题照显示", () => {
    useInputStore.getState().open({
      title: "接入 2 个加密空间",
      placeholder: "输入口令（与对端那台一致）",
      type: "password",
      onSubmit: () => undefined,
    });
    render();
    const input = container.querySelector("input");
    expect(input, "输入框应当渲染出来").toBeTruthy();
    expect(input!.getAttribute("type")).toBe("password");
    expect(input!.getAttribute("autocomplete")).toBe("current-password");
    expect(container.textContent).toContain("接入 2 个加密空间");
  });

  it("不传 type ⇒ 仍是普通文本档（别的调用方不受影响）", () => {
    useInputStore.getState().open({ title: "重命名", onSubmit: () => undefined });
    render();
    const input = container.querySelector("input");
    expect(input!.getAttribute("type")).toBe("text");
    expect(input!.getAttribute("autocomplete")).toBeNull();
  });
});

// 「时间」属性编辑器的判据：**一行只有一个可见输入框**（owner 2026-09-21：「时间咋回事？」——
// 截图里「发布于」一行并排两个时间控件，同一个时刻显示了两遍），且两条输入路径都还在。
//
// 本仓的组件测试惯例：**不用 @testing-library**，直接用 `react-dom/client` + `flushSync` +
// 原生事件（见 `communityPublishDialog.test.tsx`）。
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

import { DatetimeValueEditor } from "./DatetimeValueEditor";

const VALUE = "2026-09-20 11:29:02";

function mount(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(ui));
  return {
    host,
    inputs: () => Array.from(host.querySelectorAll("input")) as HTMLInputElement[],
    textbox: () => host.querySelector("input.prop-value") as HTMLInputElement,
    hidden: () => host.querySelector("input.prop-datetime-picker") as HTMLInputElement,
    button: () => host.querySelector("button.prop-datetime-pick") as HTMLButtonElement,
    unmount: () => {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

/** 受控 input：必须走原生 setter 再派发 input，React 才认（同仓其他测试的做法）。 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  flushSync(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(el: HTMLElement) {
  flushSync(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("DatetimeValueEditor", () => {
  it("一行只有一个可见输入框（原生选择器被藏起来，不再是两个框并排）", () => {
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      const inputs = m.inputs();
      expect(inputs).toHaveLength(2); // 手输框 + 被藏起来的原生选择器
      const visible = inputs.filter((el) => !el.classList.contains("prop-datetime-picker"));
      expect(visible).toHaveLength(1);
      expect(visible[0].getAttribute("type")).toBe("text");
      expect(m.hidden().getAttribute("type")).toBe("datetime-local");
      // 藏起来的是 1px 的类（**不是 display:none**，那会让 showPicker() 抛）
      expect(m.hidden().getAttribute("aria-hidden")).toBe("true");
      expect(m.hidden().tabIndex).toBe(-1);
    } finally {
      m.unmount();
    }
  });

  it("显示的是「给人看的形态」，不是存储形态", () => {
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      expect(m.textbox().value).toBe("2026年9月20日 11:29:02");
    } finally {
      m.unmount();
    }
  });

  it("手输合法形态 + 回车 ⇒ 回写规范存储形态", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value="" onChange={onChange} />);
    try {
      typeInto(m.textbox(), "2008年5月9日 15:30");
      pressEnter(m.textbox());
      expect(onChange).toHaveBeenCalledWith("2008-05-09 15:30:00");
    } finally {
      m.unmount();
    }
  });

  it("非法输入（2月30日）不写库，只标 is-invalid", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={onChange} />);
    try {
      typeInto(m.textbox(), "2008年2月30日");
      pressEnter(m.textbox());
      expect(onChange).not.toHaveBeenCalled();
      expect(m.host.querySelector(".prop-value.is-invalid")).not.toBeNull();
      expect(m.host.querySelector(".prop-invalid")).not.toBeNull();
    } finally {
      m.unmount();
    }
  });

  it("清空 = 有意删除该属性值（不报非法）", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={onChange} />);
    try {
      typeInto(m.textbox(), "   ");
      pressEnter(m.textbox());
      expect(onChange).toHaveBeenCalledWith("");
    } finally {
      m.unmount();
    }
  });

  it("📅 按钮调用 showPicker()（原生选择器那条路径仍在）", () => {
    const showPicker = vi.fn();
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      Object.defineProperty(m.hidden(), "showPicker", { value: showPicker, configurable: true });
      flushSync(() => m.button().click());
      expect(showPicker).toHaveBeenCalledTimes(1);
    } finally {
      m.unmount();
    }
  });

  it("环境不支持 showPicker 时退化成聚焦，不抛错", () => {
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      Object.defineProperty(m.hidden(), "showPicker", { value: undefined, configurable: true });
      expect(() => flushSync(() => m.button().click())).not.toThrow();
    } finally {
      m.unmount();
    }
  });

  it("原生选择器改动 ⇒ 回写规范存储形态", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={onChange} />);
    try {
      typeInto(m.hidden(), "2008-05-09T15:30:00");
      expect(onChange).toHaveBeenCalledWith("2008-05-09 15:30:00");
    } finally {
      m.unmount();
    }
  });
});

// 「时间」属性编辑器的判据（2026-09-22，owner："页面时间属性的控件采用和日期一样风格的控件，
// 不要再额外加按钮"）：**就是一个原生 `datetime-local` 控件，一个多余的按钮都没有**。
//
// 沿革（两次 owner 反馈、方向相反，所以这个文件的前两条断言钉得比较死）：
//   · 2026-09-21 owner：「时间咋回事？」—— 当时一行并排两个框（原生选择器 ＋ 手输框）。
//     那一轮改成"手输框（显示 2026年9月20日 11:29:02）＋ 一枚日历按钮开原生选择器"，
//     原生框被藏成 1px；
//   · 2026-09-22 owner：「采用和日期一样风格的控件，不要再额外加按钮」⇒ 回到原生控件本身。
//     于是**按钮、手输框、被藏起来的 1px 原生框**都不该再存在；App.css 里那套
//     `.prop-datetime*` 样式也不该留（死规则会被下面第二条判据拦下）。
//
// 本仓的组件测试惯例：**不用 @testing-library**，直接用 `react-dom/client` + `flushSync` +
// 原生事件（见 `communityPublishDialog.test.tsx`）。
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    root,
    inputs: () => Array.from(host.querySelectorAll("input")) as HTMLInputElement[],
    control: () => host.querySelector("input.prop-value") as HTMLInputElement,
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

describe("DatetimeValueEditor（原生 datetime-local）", () => {
  it("只有一个控件：`input[type=datetime-local]`，**没有任何按钮**", () => {
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      const inputs = m.inputs();
      expect(inputs, "整行只该有一个输入框").toHaveLength(1);
      expect(inputs[0].getAttribute("type")).toBe("datetime-local");
      expect(inputs[0].getAttribute("step"), "要能选到秒").toBe("1");
      expect(inputs[0].className).toContain("prop-value");
      // "不要再额外加按钮"——日历按钮、清除按钮、任何按钮都不该有
      expect(m.host.querySelectorAll("button"), "这一格不该再有任何按钮").toHaveLength(0);
      // 手输框那条路（显示「2026年9月20日 11:29:02」的 text input）已按要求去掉
      expect(m.host.querySelectorAll('input[type="text"]')).toHaveLength(0);
    } finally {
      m.unmount();
    }
  });

  it("App.css 里那套 `.prop-datetime*` 规则已经删干净（不留死样式）", () => {
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
    // 只认**真的规则**（同一行里后面跟着 `{`）；散文/注释里提到类名不算。
    const ruleRe = /(^|\})[^{}\n]*\.prop-datetime[^{}\n]*\{/m;
    const hit = ruleRe.exec(css);
    expect(hit?.[0] ?? "", "App.css 里不该再有 .prop-datetime* 规则（那是手输框 + 日历按钮那一版）").toBe("");
  });

  it("规范存储形态 → 控件的值（`YYYY-MM-DDTHH:mm:ss`）", () => {
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      expect(m.control().value).toBe("2026-09-20T11:29:02");
    } finally {
      m.unmount();
    }
  });

  it("控件改动 ⇒ 回写**规范存储形态**", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={onChange} />);
    try {
      typeInto(m.control(), "2008-05-09T15:30:00");
      expect(onChange).toHaveBeenCalledWith("2008-05-09 15:30:00");
    } finally {
      m.unmount();
    }
  });

  it("清空 = 有意删除该属性值（写空串），与数据库视图同一语义", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={onChange} />);
    try {
      typeInto(m.control(), "");
      expect(onChange).toHaveBeenCalledWith("");
    } finally {
      m.unmount();
    }
  });

  it("坏值（不是规范形态）显示成空，不会被**悄悄显示成别的时间**", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value="坏数据" onChange={onChange} />);
    try {
      expect(m.control().value).toBe("");
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      m.unmount();
    }
  });

  it("空值 ⇒ 控件为空、也不写库（原生控件自带 yyyy/mm/dd 提示，不需要额外说明）", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value="" onChange={onChange} />);
    try {
      expect(m.control().value).toBe("");
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      m.unmount();
    }
  });

  it("带 `title`：原生控件没有可见标签，鼠标停上去要说明这一格是什么", () => {
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      expect(m.control().getAttribute("title") ?? "").toContain("日期");
      expect(m.control().getAttribute("title") ?? "").toContain("秒");
    } finally {
      m.unmount();
    }
  });

  it("外部改了同一个属性值 ⇒ 控件跟着变（受控，不留上一次的草稿）", () => {
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      expect(m.control().value).toBe("2026-09-20T11:29:02");
      flushSync(() => m.root.render(<DatetimeValueEditor value="2008-05-09 15:30:00" onChange={() => {}} />));
      // ⚠️ 浏览器会把秒为 0 的那一段规范化掉（`…15:30:00` → `…15:30`）：
      //    所以这里只钉"日子/时刻对了"，别去要求 `:00` 一定在。
      expect(m.control().value).toMatch(/^2008-05-09T15:30(:00)?$/);
    } finally {
      m.unmount();
    }
  });

  it("库里是坏值时，用户在控件上选一个 ⇒ 正常回写规范形态（坏值不是死路）", () => {
    const onChange = vi.fn();
    const m = mount(<DatetimeValueEditor value="坏数据" onChange={onChange} />);
    try {
      typeInto(m.control(), "2008-05-09T15:30:00");
      expect(onChange).toHaveBeenCalledWith("2008-05-09 15:30:00");
    } finally {
      m.unmount();
    }
  });
});

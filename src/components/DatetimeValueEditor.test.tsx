// 「时间」属性编辑器的判据：**一行只有一个可见输入框**（owner 2026-09-21：「时间咋回事？」——
// 截图里「发布于」一行并排两个时间控件，同一个时刻显示了两遍），且两条输入路径都还在。
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

  it("CSS：日历按钮的方框与属性行里那三个图标按钮**逐项相同**（尺寸对齐靠判据，不靠肉眼）", () => {
    // owner 的两句话就是这条判据的两个断言的来历：
    //   ① 「尺寸没有对齐」→ 盒子属性（display/width/height/padding/border/background）必须与
    //      `.prop-order` 一致；② 「跟其它 SVG 图标样式不搭调」→ 颜色/圆角/hover 也要同一套。
    // 读真实 `src/App.css`：以前那种"按钮里放 emoji"的写法在这条判据下必然红。
    // 读真实 `src/App.css`（`import.meta.url` 在 vitest 里不是 file: 协议，所以按 cwd 取）：
    // 以前那种"按钮里放 emoji"的写法在这条判据下必然红。
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
    const boxOf = (selector: string) => {
      // 选择器列表里包含该选择器、且**后面不是 `-`/字母**（`.prop-order` 不能匹配到 `.prop-order-btns`）
      const re = new RegExp(`(^|})\\s*([^{}]*\\${selector}(?![\\w-])[^{}]*)\\{([^}]*)\\}`, "m");
      const m = re.exec(css);
      expect(m, `App.css 里找不到 ${selector} 的规则`).not.toBeNull();
      const decls: Record<string, string> = {};
      for (const part of m![3].split(";")) {
        const i = part.indexOf(":");
        if (i > 0) decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      return decls;
    };
    const pick = boxOf(".prop-datetime-pick");
    const order = boxOf(".prop-order");
    for (const key of ["display", "align-items", "justify-content", "width", "height", "padding", "border", "background", "border-radius"]) {
      expect(`${key}: ${pick[key]}`, `日历按钮的 ${key} 应与「上移/下移/移除」那三个一致`).toBe(`${key}: ${order[key]}`);
    }
    expect(pick.color).toBe("var(--text-faint)");
    // hover 档也要同一套（`.prop-order:hover, .prop-remove:hover { color: var(--text); background: var(--hover) }`）
    const hoverRe = /\.prop-order:hover[^{}]*\{([^}]*)\}/m;
    const hm = hoverRe.exec(css)!;
    const hover = Object.fromEntries(
      hm[1].split(";").map((s) => s.split(":")).filter((kv) => kv.length === 2).map((kv) => [kv[0].trim(), kv[1].trim()]),
    );
    const pickHoverM = /\.prop-datetime-pick:hover\s*\{([^}]*)\}/m.exec(css)!;
    const pickHover = Object.fromEntries(
      pickHoverM[1].split(";").map((s) => s.split(":")).filter((kv) => kv.length === 2).map((kv) => [kv[0].trim(), kv[1].trim()]),
    );
    expect(pickHover.color).toBe(hover.color);
    expect(pickHover.background).toBe(hover.background);
  });

  it("日历按钮用的是属性行里那套 SVG 画法（不是 emoji，尺寸与兄弟按钮一致）", () => {
    // owner 2026-09-21 截图：「日期选择按钮尺寸没有对齐，而且跟其它 SVG 图标样式不搭调」——
    // 原来按钮里放的是 `📅` emoji：字号/行高由字体决定，跟 `prop-ico` 那 13×13 的线性图标不是一家，
    // 盒子尺寸也跟「上移/下移/移除」那三个 18×18 的对不上。
    const m = mount(<DatetimeValueEditor value={VALUE} onChange={() => {}} />);
    try {
      const btn = m.button();
      const svg = btn.querySelector("svg")!;
      expect(svg).not.toBeNull();
      // ① 与兄弟按钮同一套 class/画法：`prop-ico` ＋ 13×13 ＋ stroke 1.8 ＋ round
      expect(svg.getAttribute("class")).toBe("prop-ico");
      expect(svg.getAttribute("width")).toBe("13");
      expect(svg.getAttribute("height")).toBe("13");
      expect(svg.getAttribute("stroke-width")).toBe("1.8");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      // ② 按钮里**不许再有字**（emoji 就是文字节点；留着就等于两套图标并存）
      expect((btn.textContent ?? "").trim()).toBe("");
      // ③ 无障碍名字还在（图标本身 aria-hidden，名字靠 aria-label）
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(btn.getAttribute("aria-label")).toContain("日期选择器");
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

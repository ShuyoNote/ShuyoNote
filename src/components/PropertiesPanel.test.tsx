// 「**别处**替这一页写了属性 ⇒ 属性区要重拉」——2026-09-23 用户实测那条的判据：
//   社区文章存进笔记后，属性区不能及时看到，需重新打开才有。
//
// 另有 B1（属性区 P0）五条：计数文案 / 系统字段只读 / 空值占位 / 两个 ＋ 入口 / 行操作按钮只在 hover 样式里。
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mock = vi.hoisted(() => ({
  getPageProps: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  listAttrDefs: vi.fn(async () => [] as unknown[]),
  pageTags: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));

vi.mock("../lib/api", () => ({
  api: {
    getPageProps: (...a: unknown[]) => mock.getPageProps(...a),
    listAttrDefs: () => mock.listAttrDefs(),
    pageTags: (...a: unknown[]) => mock.pageTags(...a),
    listTags: async () => [],
  },
}));

import { PropertiesPanel } from "./PropertiesPanel";
import { usePropertyUiStore } from "../store/propertyUi";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function mount(pageId = "p1") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(PropertiesPanel, { pageId })));
  return { root, host };
}

const prop = (name: string, value = "", attr_type = "text") => ({
  attr_id: `a-${name}`,
  name,
  attr_type,
  value,
  options: [],
});

async function mountWith(props: unknown[], tags: unknown[] = []) {
  mock.getPageProps.mockResolvedValue(props);
  mock.pageTags.mockResolvedValue(tags);
  const h = mount();
  await flush();
  await new Promise((r) => setTimeout(r, 0));
  await flush();
  return h;
}

beforeEach(() => {
  mock.getPageProps.mockClear();
  mock.listAttrDefs.mockClear();
  mock.pageTags.mockClear();
  mock.getPageProps.mockResolvedValue([]);
  mock.pageTags.mockResolvedValue([]);
  usePropertyUiStore.setState({ propsRev: 0 });
});

describe("PropertiesPanel —— 属性在别处被改过要重拉", () => {
  it("挂载时拉一次；`bumpProps()` 之后**再拉一次**（修前这里只有 1 次）", async () => {
    const { root } = mount();
    await flush();
    expect(mock.getPageProps).toHaveBeenCalledTimes(1);

    flushSync(() => usePropertyUiStore.getState().bumpProps());
    await flush();
    expect(mock.getPageProps).toHaveBeenCalledTimes(2);
    // 两次都是同一页（bump 不该把 pageId 弄丢或去拉别的页）
    expect(mock.getPageProps.mock.calls[1][0]).toBe("p1");

    flushSync(() => root.unmount());
  });

  it("`propsRev` 没变时不会白拉（别把每一次重渲染都变成一次查询）", async () => {
    const { root } = mount();
    await flush();
    expect(mock.getPageProps).toHaveBeenCalledTimes(1);
    flushSync(() => root.render(createElement(PropertiesPanel, { pageId: "p1" })));
    await flush();
    expect(mock.getPageProps).toHaveBeenCalledTimes(1);
    flushSync(() => root.unmount());
  });
});

describe("B1：属性区 P0", () => {
  it("① 计数文案 = 数据算出的「4 项属性 · 3 个标签」", async () => {
    const { root, host } = await mountWith(
      [prop("甲"), prop("乙"), prop("丙"), prop("丁")],
      [{ id: "t1", name: "a" }, { id: "t2", name: "b" }, { id: "t3", name: "c" }],
    );
    expect(host.textContent).toContain("4 项属性 · 3 个标签");
    flushSync(() => root.unmount());
  });

  it("② 系统字段进「系统信息」折叠，且无 ✕/↑↓", async () => {
    const { root, host } = await mountWith([prop("存于", "空间 A"), prop("备注", "x")]);
    const system = host.querySelector(".prop-system");
    expect(system?.textContent).toContain("系统信息");
    expect(system?.textContent).toContain("存于");
    expect(system?.querySelector(".prop-remove")).toBeNull();
    expect(system?.querySelector(".prop-order")).toBeNull();
    expect(system?.querySelector("input,select,textarea")).toBeNull();
    flushSync(() => root.unmount());
  });

  it("③ 空值占位 =「未设置（点击填写）」（不是空输入框）", async () => {
    const { root, host } = await mountWith([prop("备注", "")]);
    const empty = host.querySelector(".prop-empty");
    expect(empty?.textContent).toBe("未设置（点击填写）");
    expect(host.querySelector(".prop-row input.prop-value")).toBeNull();
    flushSync(() => root.unmount());
  });

  it("④ 两个 ＋ 入口：header「＋ 添加属性」＋标签行「＋」", async () => {
    const { root, host } = await mountWith([prop("备注", "x")]);
    const btns = Array.from(host.querySelectorAll("button"));
    expect(btns.some((b) => b.textContent?.includes("＋ 添加属性"))).toBe(true);
    const addTag = btns.find((b) => b.getAttribute("aria-label") === "添加标签");
    expect(addTag?.textContent).toBe("＋");
    flushSync(() => root.unmount());
  });

  it("⑤ 用户属性行有操作按钮（✕/↑↓），系统行没有；hover 隐藏由 CSS 负责", async () => {
    const { root, host } = await mountWith([prop("备注", "x"), prop("创建", "2026")]);
    const userRow = Array.from(host.querySelectorAll(".prop-row")).find((r) => r.textContent?.includes("备注"));
    expect(userRow?.querySelector(".prop-order-btns")).toBeTruthy();
    expect(userRow?.querySelector(".prop-remove")).toBeTruthy();
    flushSync(() => root.unmount());
  });
});

describe("B2：类型化展示", () => {
  it("来源 URL ⇒ 链接（省略中段）+ 复制，展示态无 input", async () => {
    const { root, host } = await mountWith([prop("来源", "example.com/very/long/path/that/should/be/ellipsized/end")]);
    const a = host.querySelector("a.prop-link") as HTMLAnchorElement | null;
    expect(a?.getAttribute("href")).toBe("https://example.com/very/long/path/that/should/be/ellipsized/end");
    expect(a?.textContent).toContain("…");
    expect(host.querySelector(".prop-link-copy")).toBeTruthy();
    expect(host.querySelector(".prop-row input.prop-value")).toBeNull();
    flushSync(() => root.unmount());
  });

  it("日期 ⇒ 到分钟 + 相对时间 + 时区（展示态无日期控件）", async () => {
    const { root, host } = await mountWith([prop("日期", "2026-10-30 11:30", "date")]);
    const el = host.querySelector(".prop-temporal");
    expect(el?.textContent).toContain("2026-10-30 11:30");
    expect(el?.textContent).toContain("+08:00");
    expect(el?.textContent).toMatch(/前|后|刚刚/);
    expect(host.querySelector('input[type="date"]')).toBeNull();
    flushSync(() => root.unmount());
  });
});


describe("B3：收尾", () => {
  const css = () => readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");
  const src = () => readFileSync(resolve(process.cwd(), "src/lib/communitySave.ts"), "utf8");

  it("① header 同行：计数与「＋ 添加属性」在同一 head-row", async () => {
    const { root, host } = await mountWith([prop("备注", "x")]);
    const head = host.querySelector(".properties-head-row");
    expect(head?.querySelector(".properties-toggle")?.textContent).toContain("项属性");
    expect(head?.textContent).toContain("＋ 添加属性");
    flushSync(() => root.unmount());
  });

  it("② 值列 grid：.prop-row 与标签行共用 86px minmax(0,1fr) auto", () => {
    const c = css();
    expect(c).toContain("grid-template-columns: 86px minmax(0, 1fr) auto");
  });

  it("③ 作者 person chip（展示态无 input）", async () => {
    const { root, host } = await mountWith([prop("作者", "张三")]);
    const row = Array.from(host.querySelectorAll(".prop-row")).find((r) => r.textContent?.includes("张三"));
    expect(row?.querySelector(".prop-person")).toBeTruthy();
    expect(row?.querySelector("input")).toBeNull();
    flushSync(() => root.unmount());
  });

  it("④ 日期展示态无 input（hover 编辑按钮在 DOM 里）", async () => {
    const { root, host } = await mountWith([prop("日期", "2026-10-30 11:30", "date")]);
    expect(host.querySelector(".prop-temporal")?.textContent).toContain("+08:00");
    expect(host.querySelector('input[type="date"]')).toBeNull();
    expect(host.querySelector(".prop-edit-hint")?.textContent).toBe("编辑");
    flushSync(() => root.unmount());
  });

  it("⑤ 来源行说明小字存在，且复制/编辑在 hover actions 里", async () => {
    const { root, host } = await mountWith([prop("来源", "https://example.com/x")]);
    expect(host.querySelector(".prop-note")?.textContent).toContain("发布到社区时会同时写进正文最前面");
    expect(host.querySelector(".prop-link-actions .prop-link-copy")).toBeTruthy();
    flushSync(() => root.unmount());
  });

  it("⑥ 正文引文：sourceLine 保留「> 来源：」且 CSS 有 citation 样式", () => {
    expect(src()).toContain("> 来源：");
    const c = css();
    expect(c).toContain("blockquote");
    expect(c).toContain("border-left: 3px solid");
  });
});

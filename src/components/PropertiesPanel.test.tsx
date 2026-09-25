// 「**别处**替这一页写了属性 ⇒ 属性区要重拉」——2026-09-23 用户实测那条的判据：
//   社区文章存进笔记后，属性区不能及时看到，需重新打开才有。
//
// 为什么会有这条：属性区是**自己拉** `api.getPageProps` 存进本地 state 的，而社区存笔记那条路
// （`communitySaveNote.savePostAsNote`）是"**先建页、后写属性**"，写的时候走的是命令、不经过属性区
// ⇒ 面板挂载时拉到的是"没属性"的那一份。修法是写完 `usePropertyUiStore.bumpProps()`，
// 面板把它放进加载 effect 的依赖里。这里钉的就是那个依赖**真的接上了**。
//
// ⚠️ 这一条在修之前是红的（`getPageProps` 只会被调一次），所以它是**回归判据**，不是装饰。
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createElement } from "react";

const getPageProps = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock("../lib/api", () => ({
  api: {
    getPageProps: (...a: unknown[]) => getPageProps(...a),
    listAttrDefs: async () => [],
    pageTags: async () => [],
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

describe("PropertiesPanel —— 属性在别处被改过要重拉", () => {
  beforeEach(() => {
    getPageProps.mockClear();
    usePropertyUiStore.setState({ propsRev: 0 });
  });

  it("挂载时拉一次；`bumpProps()` 之后**再拉一次**（修前这里只有 1 次）", async () => {
    const { root } = mount();
    await flush();
    expect(getPageProps).toHaveBeenCalledTimes(1);

    flushSync(() => usePropertyUiStore.getState().bumpProps());
    await flush();
    expect(getPageProps).toHaveBeenCalledTimes(2);
    // 两次都是同一页（bump 不该把 pageId 弄丢或去拉别的页）
    expect(getPageProps.mock.calls[1][0]).toBe("p1");

    flushSync(() => root.unmount());
  });

  it("`propsRev` 没变时不会白拉（别把每一次重渲染都变成一次查询）", async () => {
    const { root } = mount();
    await flush();
    expect(getPageProps).toHaveBeenCalledTimes(1);
    flushSync(() => root.render(createElement(PropertiesPanel, { pageId: "p1" })));
    await flush();
    expect(getPageProps).toHaveBeenCalledTimes(1);
    flushSync(() => root.unmount());
  });
});

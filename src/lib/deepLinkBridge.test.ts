// 深链**投递**的测试（`src/lib/deepLinkBridge.ts`）。
//
// 这一层最容易出的错**不是**解析错，而是**漏投/重投**——而两者的表现都很像"玄学"：
//
//   · 漏投 → "第一次点链接没反应，第二次正常"（冷启动那条丢了，见 bridge 顶部注释）；
//   · 重投 → "怎么又问了一遍要不要存"。
//
// 所以这里钉三条不变式：① 冷启动 drain 到的一定送进去；② 事件到的一定送进去；
// ③ 不该管的（别的协议、空值）一条都不送。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `mountDeepLinks` 只依赖 `platform.event.listen` 与 `api.deepLinkTake` 两件事；
// 把这两个替换掉，就不需要真后端（这也是为什么它不 import 任何 store）。
const listeners: Array<(e: { payload: string[] }) => void> = [];
let taken: string[] = [];
let takeRejects = false;

vi.mock("./platform", () => ({
  platform: {
    event: {
      listen: vi.fn(async (event: string, handler: (e: { payload: string[] }) => void) => {
        expect(event).toBe("deep-link-new-url");
        listeners.push(handler);
        return () => {
          const i = listeners.indexOf(handler);
          if (i >= 0) listeners.splice(i, 1);
        };
      }),
    },
  },
}));

vi.mock("./api", () => ({
  api: {
    deepLinkTake: vi.fn(async () => {
      if (takeRejects) throw new Error("backend down");
      return taken;
    }),
  },
}));

import { mountDeepLinks } from "./deepLinkBridge";

/** 让 `void promise.then(...)` 里排队的微任务跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 收集被投递进来的 URL。写成块体是有意的：箭头函数直接返回 `push` 的 number
 *  不满足 `void | Promise<void>`，tsc 会拦（这里踩过一次）。 */
function collector(): { got: string[]; handler: (u: string) => void } {
  const got: string[] = [];
  return {
    got,
    handler: (u: string) => {
      got.push(u);
    },
  };
}

describe("mountDeepLinks（深链投递）", () => {
  beforeEach(() => {
    listeners.length = 0;
    taken = [];
    takeRejects = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("冷启动：drain 到的 URL 会被送进接入缝", async () => {
    taken = ["shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2F1"];
    const { got, handler } = collector();
    mountDeepLinks(handler);
    await flush();
    expect(got).toEqual(["shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2F1"]);
  });

  it("普通启动：队列为空时一条都不送（零副作用）", async () => {
    taken = [];
    const { got, handler } = collector();
    mountDeepLinks(handler);
    await flush();
    expect(got).toEqual([]);
  });

  it("应用已开着：事件到达时送进去", async () => {
    const { got, handler } = collector();
    mountDeepLinks(handler);
    await flush();
    expect(listeners).toHaveLength(1);
    listeners[0]({ payload: ["shuyonote://compose?title=%E4%BD%A0%E5%A5%BD"] });
    expect(got).toEqual(["shuyonote://compose?title=%E4%BD%A0%E5%A5%BD"]);
  });

  it("不是我们的协议的链接一条都不送（过滤在投递层做，语义层不必再防一遍）", async () => {
    const { got, handler } = collector();
    mountDeepLinks(handler);
    await flush();
    listeners[0]({ payload: ["https://community.shuyo.cn/post/1", "mailto:a@b.c"] });
    // 空值 / 非字符串也不能把它炸掉（事件载荷来自 Rust，理论上可信，但代价极低）。
    listeners[0]({ payload: [undefined as unknown as string, ""] });
    expect(got).toEqual([]);
  });

  it("卸载后不再投递（否则重挂会叠出多份监听，同一条链接被处理多次）", async () => {
    const { got, handler } = collector();
    const unmount = mountDeepLinks(handler);
    await flush();
    expect(listeners).toHaveLength(1);
    unmount();
    await flush();
    expect(listeners).toHaveLength(0);
    // 卸载之后再来的事件不该被处理。
    for (const l of listeners) l({ payload: ["shuyonote://save?url=x"] });
    expect(got).toEqual([]);
  });

  it("drain 失败不抛给调用方（深链非关键路径，不该拖垮启动）", async () => {
    takeRejects = true;
    const { got, handler } = collector();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => mountDeepLinks(handler)).not.toThrow();
    await flush();
    expect(got).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });

  it("handler 同步抛错不会漏成未捕获异常，也不影响后续投递", async () => {
    // 这条用例抓出过一个真 bug：`Promise.resolve(handler(raw))` 会**先执行** handler
    // 再包 Promise，于是同步 throw 直接漏出去（deliver 是同步调用的），`.catch` 接不到。
    // 正确写法是 `(async () => handler(raw))()`。
    taken = ["shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2F1"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const got: string[] = [];
    mountDeepLinks((u) => {
      got.push(u);
      throw new Error("接入缝炸了");
    });
    await flush();
    listeners[0]({ payload: ["shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2F2"] });
    await flush();
    expect(got).toHaveLength(2);
    expect(spy).toHaveBeenCalled();
  });

  // ── OS 侧约定："原样传递"─────────────────────────────────────────────────
  //
  // 真机取证：系统交给应用的那条 URL 会被归一化成 `shuyonote://save/?url=…`
  // （动作名后多一个 `/`），百分号编码完好。下面钉住投递层**不碰这些字节**：
  // 它只做"是不是 shuyonote: 开头"这一个判断，然后原样交出去。
  // 解析与拒绝（含"只接受 https"那类原因）由语义层负责，在
  // `deepLink.test.ts` 与 `communitySaveDialog.test.ts` 里各自钉着。
  it("原样传递：不做去空白以外的任何改动（含真机归一化出的 `save/` 与百分号编码）", async () => {
    // 真机抓到的形状（不是我们造的，是 ShellExecute 交给应用的）：
    const fromOs =
      "shuyonote://save/?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2Fplugin-recipes-batch-1";
    taken = [fromOs];
    const { got, handler } = collector();
    mountDeepLinks(handler);
    await flush();
    // 逐字节相同：没有去掉那个 `/`、没有解码 %3A、没有补 `//`。
    expect(got).toEqual([fromOs]);
  });

  it("非法链接（指向回环）也照样原样送进语义层——由语义层给出原因，投递层不预判", async () => {
    // 这一条正是"不许静默失败"的前提：投递层如果自作主张拦掉它，用户就永远看不到原因。
    const bad = "shuyonote://save/?url=http%3A%2F%2F127.0.0.1%2Fx";
    taken = [bad];
    const { got, handler } = collector();
    mountDeepLinks(handler);
    await flush();
    expect(got).toEqual([bad]);
  });
});

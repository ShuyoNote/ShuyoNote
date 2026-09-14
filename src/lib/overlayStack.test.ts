// 浮层栈：Android 返回键的第一顺位消费者。
//
// 这些断言钉的是"返回键一次只关一层、栈空才返回 false"这条行为契约——
// 它是"返回键不退出应用"的**唯一**依据（壳层只看 `handle()` 的返回值）。
import { describe, it, expect, beforeEach } from "vitest";
import {
  BACK_BRIDGE_KEY,
  closeTopOverlay,
  installBackBridge,
  overlayDepth,
  overlayIds,
  pushOverlay,
  resetOverlayStackForTest,
} from "../lib/overlayStack";

beforeEach(() => resetOverlayStackForTest());

describe("overlayStack", () => {
  it("后进先出：关掉的永远是最上层", () => {
    const closed: string[] = [];
    pushOverlay("a", () => closed.push("a"));
    pushOverlay("b", () => closed.push("b"));
    expect(overlayIds()).toEqual(["a", "b"]);

    expect(closeTopOverlay()).toBe(true);
    expect(closed).toEqual(["b"]);
    expect(closeTopOverlay()).toBe(true);
    expect(closed).toEqual(["b", "a"]);
    // 栈空 ⇒ false：壳层据此放行返回键（退出应用）。
    expect(closeTopOverlay()).toBe(false);
    expect(overlayDepth()).toBe(0);
  });

  it("注销是幂等的（StrictMode 会把 effect 跑两遍，不幂等就会留下幽灵层）", () => {
    const close = () => {};
    const off = pushOverlay("a", close);
    off();
    off();
    off();
    expect(overlayDepth()).toBe(0);
  });

  it("注销的是自己那一层，不是栈顶（中间层卸载不能把上面的层带走）", () => {
    const closed: string[] = [];
    const offA = pushOverlay("a", () => closed.push("a"));
    pushOverlay("b", () => closed.push("b"));
    pushOverlay("c", () => closed.push("c"));

    offA();
    expect(overlayIds()).toEqual(["b", "c"]);
    expect(closeTopOverlay()).toBe(true);
    expect(closed).toEqual(["c"]);
  });

  it("某一层的 close 抛异常也要算作关掉了一层（返回键不能卡死）", () => {
    pushOverlay("boom", () => {
      throw new Error("炸了");
    });
    // 不让控制台噪音污染测试输出
    const orig = console.error;
    console.error = () => {};
    try {
      expect(closeTopOverlay()).toBe(true);
    } finally {
      console.error = orig;
    }
    expect(overlayDepth()).toBe(0);
  });

  it("桥的 handle() 返回**真布尔**：壳层用 === true 判定", () => {
    const w = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window;
    const off = installBackBridge(w);
    const bridge = (w as unknown as Record<string, { handle: () => boolean; depth: () => number; ids: () => string[] }>)[
      BACK_BRIDGE_KEY
    ];
    expect(bridge).toBeTruthy();
    // 栈空 ⇒ false（壳层会退出应用）
    expect(bridge.handle()).toBe(false);
    let closed = 0;
    pushOverlay("search", () => {
      closed++;
    });
    expect(bridge.depth()).toBe(1);
    expect(bridge.ids()).toEqual(["search"]);
    expect(bridge.handle()).toBe(true);
    expect(closed).toBe(1);
    expect(bridge.handle()).toBe(false);

    off();
    expect((w as unknown as Record<string, unknown>)[BACK_BRIDGE_KEY]).toBeUndefined();
  });
});

// `public/es-polyfills.js` 的行为验收（**不是**"文件存在"那种门禁）。
//
// 为什么要有：这个补齐层只在**老 WebView**上真正干活，本机（新版 Chrome/Node）跑起来
// 它是**空操作**——也就是说"本机一切正常"完全不能说明它对。所以这里先把原生实现删掉，
// 装出一个"Chrome 114"的处境，再逐条钉语义；顺带钉住"幂等"和"绝不覆盖原生实现"。
//
// ★ 2026-09-25 扩容（真机 Xiaomi MIX 2 / Android 9 / **系统 WebView Chrome 80**）：
//   那台机器上应用**根本起不来** —— 先 `Uncaught SyntaxError: Unexpected token '='`
//   （产物里的 `??=`/`||=`/`&&=`，要 Chrome 85+，靠 `vite.config.ts` 的 `build.target: "chrome80"` 解决），
//   再 `Object.hasOwn is not a function`（Chrome 93+）⇒ 补齐层从"给 pdf.js 兜底"扩成
//   **"给这个应用在 WebView 80 上兜底"**：下面这一组的每条都在那台机器的启动路径上真的会走到。
//
// 用法：pnpm vitest run scripts/es-polyfills.test.mjs

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const POLYFILL = "../public/es-polyfills.js";

// 原生实现先存起来，测完还回去（同一进程里还有别的测试文件，别把它们搞坏）。
const nativeWithResolvers = Promise.withResolvers;
const nativeAny = AbortSignal.any;

/// WebView 80 缺的那些：原生实现 ＋ 它挂在哪（删除/恢复都要走同一个位置）。
const MISSING_IN_WEBVIEW_80 = [
  [Object, "hasOwn"],
  [String.prototype, "replaceAll"],
  [Array.prototype, "at"],
  [String.prototype, "at"],
  [Array.prototype, "findLast"],
  [Array.prototype, "findLastIndex"],
  [crypto, "randomUUID"],
  [globalThis, "structuredClone"],
  [globalThis, "reportError"],
  [Intl, "Segmenter"],
];
if (typeof Element === "function") MISSING_IN_WEBVIEW_80.push([Element.prototype, "replaceChildren"]);
if (typeof DocumentFragment === "function") MISSING_IN_WEBVIEW_80.push([DocumentFragment.prototype, "replaceChildren"]);

const nativeInWebView80 = MISSING_IN_WEBVIEW_80.map(([obj, key]) => [obj, key, obj[key]]);

async function importPolyfill() {
  // 每次都要全新的求值：IIFE 只在 import 时执行一次，模块缓存会挡住第二次。
  const url = new URL(POLYFILL, import.meta.url).href + `?t=${Math.random()}`;
  await import(/* @vite-ignore */ url);
}

async function loadPolyfillWithApisMissing() {
  delete Promise.withResolvers;
  delete AbortSignal.any;
  await importPolyfill();
}

/// 装出"WebView 80"的处境：把这一组原生实现全删掉，再 import 补齐层。
async function loadPolyfillAsWebView80() {
  delete Promise.withResolvers;
  delete AbortSignal.any;
  for (const [obj, key] of MISSING_IN_WEBVIEW_80) delete obj[key];
  await importPolyfill();
}

beforeAll(async () => {
  expect(typeof nativeWithResolvers).toBe("function"); // 本机应当有原生实现，否则这个测试没意义
  expect(typeof nativeAny).toBe("function");
  // ⚠️ 逐条要求"本机本来就有"是**错的**：这一组里有的本机未必有（`reportError` 就是），
  //    而补齐层的判据是 `typeof x !== "function"` ⇒ 本机没有也照样装得上。
  //    所以只对"确实存在"的那些做对账，另外显式钉几条承重的。
  for (const [obj, key, val] of nativeInWebView80) {
    if (typeof val !== "function") continue;
    expect(typeof obj[key], `${key} 在本机应当有原生实现`).toBe("function");
  }
  expect(typeof Object.hasOwn).toBe("function");
  expect(typeof structuredClone).toBe("function");
  expect(typeof Intl.Segmenter).toBe("function");
  expect(typeof crypto.randomUUID).toBe("function");
});

afterAll(() => {
  Promise.withResolvers = nativeWithResolvers;
  AbortSignal.any = nativeAny;
  for (const [obj, key, val] of nativeInWebView80) obj[key] = val;
});

describe("老 WebView 的处境：删掉原生实现后，补齐层必须把它们装回来", () => {
  it("Promise.withResolvers 的返回值接得住 resolve / reject", async () => {
    await loadPolyfillWithApisMissing();
    expect(typeof Promise.withResolvers).toBe("function");

    const cap = Promise.withResolvers();
    expect(cap.promise).toBeInstanceOf(Promise);
    expect(typeof cap.resolve).toBe("function");
    expect(typeof cap.reject).toBe("function");

    cap.resolve(42);
    await expect(cap.promise).resolves.toBe(42);

    const cap2 = Promise.withResolvers();
    cap2.reject(new Error("boom"));
    await expect(cap2.promise).rejects.toThrow("boom");
  });

  it("AbortSignal.any：任一信号 abort ⇒ 返回信号以同一个 reason abort", async () => {
    await loadPolyfillWithApisMissing();
    expect(typeof AbortSignal.any).toBe("function");

    const a = new AbortController();
    const b = new AbortController();
    const any = AbortSignal.any([a.signal, b.signal]);
    expect(any.aborted).toBe(false);

    const reason = new Error("来自 b");
    b.abort(reason);
    expect(any.aborted).toBe(true);
    expect(any.reason).toBe(reason);
  });

  it("AbortSignal.any：已经 abort 的输入要**立刻**传染（含 reason）", () => {
    const pre = new AbortController();
    const reason = new Error("早就 abort 了");
    pre.abort(reason);
    const any = AbortSignal.any([pre.signal]);
    expect(any.aborted).toBe(true);
    expect(any.reason).toBe(reason);
  });

  it("AbortSignal.any：空数组永不 abort（pdf.js 会传空数组）", () => {
    const any = AbortSignal.any([]);
    expect(any.aborted).toBe(false);
    expect(any).toBeInstanceOf(AbortSignal);
  });
});

describe("两条纪律", () => {
  it("幂等：装两次结果一致，且第二次不会换掉第一次装的那个函数", async () => {
    await loadPolyfillWithApisMissing();
    const first = Promise.withResolvers;
    // ⚠️ 第二次**不能**再删：这条测的是"补齐层自己不重复安装"，
    // 而"删了再装"测的是另一件事（第一次那条 helper 就这么写错过）。
    await importPolyfill();
    expect(Promise.withResolvers).toBe(first);
  });

  it("绝不覆盖原生实现：已经有的时候必须原样留着", async () => {
    // 先恢复原生，再 import —— 此时补齐层应当**什么都不做**。
    Promise.withResolvers = nativeWithResolvers;
    AbortSignal.any = nativeAny;
    await import(/* @vite-ignore */ new URL(POLYFILL, import.meta.url).href + `?t=${Math.random()}`);
    expect(Promise.withResolvers).toBe(nativeWithResolvers);
    expect(AbortSignal.any).toBe(nativeAny);
  });
});

describe("WebView 80 的处境：这一组也必须装回来（真机启动路径上真的会走到）", () => {
  it("Object.hasOwn：只认自有属性；null/undefined 按规范抛", async () => {
    await loadPolyfillAsWebView80();
    expect(typeof Object.hasOwn).toBe("function");
    const o = Object.create({ inherited: 1 });
    o.own = 2;
    expect(Object.hasOwn(o, "own")).toBe(true);
    expect(Object.hasOwn(o, "inherited")).toBe(false); // 原型链上的**不算**
    expect(Object.hasOwn({}, "toString")).toBe(false); // 同上（这条是 `in` 与它的分界）
    expect(() => Object.hasOwn(null, "x")).toThrow();
    expect(() => Object.hasOwn(undefined, "x")).toThrow();
  });

  it("String.prototype.replaceAll：字面量全局 ＋ `$&` 展开 ＋ 非全局正则抛", async () => {
    await loadPolyfillAsWebView80();
    expect("a-b-c".replaceAll("-", "+")).toBe("a+b+c");
    // 借引擎自己的 `replace` ⇒ 替换模式（`$&` 等）的语义是**引擎给的**，不是我手写的
    expect("a-b".replaceAll("-", "[$&]")).toBe("a[-]b");
    expect("aaa".replaceAll("aa", "b")).toBe("ba"); // 不重叠
    expect("abc".replaceAll("", "-")).toBe("-a-b-c-"); // 空 needle：按规范插在字符之间
    expect(() => "abc".replaceAll(/a/, "x")).toThrow(TypeError); // 非全局正则必须抛
    expect("abc".replaceAll(/a/g, "x")).toBe("xbc");
    expect("a-b".replaceAll("-", (m) => `<${m}>`)).toBe("a<->b"); // 函数替换
  });

  it("at()：负索引从尾部数，越界给 undefined", async () => {
    await loadPolyfillAsWebView80();
    const arr = ["a", "b", "c"];
    expect(arr.at(0)).toBe("a");
    expect(arr.at(-1)).toBe("c");
    expect(arr.at(3)).toBeUndefined();
    expect(arr.at(-4)).toBeUndefined();
    expect("abc".at(-1)).toBe("c");
    expect("abc".at(5)).toBeUndefined();
  });

  it("findLast / findLastIndex：从尾部往回找", async () => {
    await loadPolyfillAsWebView80();
    const arr = [1, 2, 3, 4];
    expect(arr.findLast((v) => v % 2 === 1)).toBe(3);
    expect(arr.findLastIndex((v) => v % 2 === 1)).toBe(2);
    expect(arr.findLast((v) => v > 9)).toBeUndefined();
    expect(arr.findLastIndex((v) => v > 9)).toBe(-1);
  });

  it("crypto.randomUUID：v4 形状（版本位/变体位）＋ 50 个不重复", async () => {
    await loadPolyfillAsWebView80();
    expect(typeof crypto.randomUUID).toBe("function");
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID();
      // 版本位必须是 4、变体位必须是 8/9/a/b —— 这两条是"是不是真 v4"的判别式
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });

  it("structuredClone：深拷贝 ＋ 循环引用不挂 ＋ Map/Set/Date 保形", async () => {
    await loadPolyfillAsWebView80();
    expect(typeof structuredClone).toBe("function");
    const src = { a: [1, { b: 2 }], d: new Date(0), m: new Map([["k", 1]]), s: new Set([1, 2]) };
    src.self = src; // 循环引用
    const copy = structuredClone(src);
    expect(copy).not.toBe(src);
    expect(copy.a).not.toBe(src.a); // 真深拷贝（不是同一个引用）
    expect(copy.a[1]).toEqual({ b: 2 });
    expect(copy.self).toBe(copy); // 循环被保留成"指向拷贝自己"，而不是无穷递归
    expect(copy.d.getTime()).toBe(0);
    expect(copy.m.get("k")).toBe(1);
    expect([...copy.s]).toEqual([1, 2]);
  });

  it("Element.replaceChildren：清空后按参数（含字符串）重建", async () => {
    await loadPolyfillAsWebView80();
    const host = document.createElement("div");
    host.innerHTML = "<b>old</b>";
    host.replaceChildren("hi", document.createElement("i"));
    expect(host.childNodes.length).toBe(2);
    expect(host.textContent).toBe("hi"); // 旧内容必须没了
    host.replaceChildren();
    expect(host.childNodes.length).toBe(0);
  });

  it("reportError：同步不抛，并把错误**交给全局那条路**（error 事件）", async () => {
    await loadPolyfillAsWebView80();
    expect(typeof reportError).toBe("function");
    const seen = [];
    const onErr = (e) => {
      seen.push(e.error);
      if (e.preventDefault) e.preventDefault();
    };
    window.addEventListener("error", onErr);
    expect(() => reportError(new Error("boom"))).not.toThrow();
    window.removeEventListener("error", onErr);
    // ★ 承重的那半：在有 DOM 的宿主里必须**真的派发 error 事件**——
    // 只测"同步不抛"是不够的（把错误吞掉也能过），那正是这个 polyfill 最该避免的形态。
    if (typeof ErrorEvent === "function") {
      expect(seen.length).toBe(1);
      expect(seen[0] && seen[0].message).toBe("boom");
    }
  });

  it("Intl.Segmenter（降级实现）：形状对、可迭代、带 segment/index/input", async () => {
    await loadPolyfillAsWebView80();
    const seg = new Intl.Segmenter("zh", { granularity: "word" });
    expect(seg.resolvedOptions().granularity).toBe("word");
    const parts = [...seg.segment("ab")];
    expect(parts.map((p) => p.segment)).toEqual(["a", "b"]);
    expect(parts[1].index).toBe(1);
    expect(parts[0].input).toBe("ab");
    // ⚠️ 如实钉住**降级**：它按码点切，不按字素簇 ⇒ 组合 emoji 会被切开（这是已知取舍，不是 bug）
    expect([...seg.segment("👍").map((p) => p.segment)].length).toBe(1);
  });
});

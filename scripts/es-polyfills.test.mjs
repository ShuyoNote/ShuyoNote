// `public/es-polyfills.js` 的行为验收（**不是**"文件存在"那种门禁）。
//
// 为什么要有：这个补齐层只在**老 WebView**上真正干活，本机（新版 Chrome/Node）跑起来
// 它是**空操作**——也就是说"本机一切正常"完全不能说明它对。所以这里先把原生实现删掉，
// 装出一个"Chrome 114"的处境，再逐条钉语义；顺带钉住"幂等"和"绝不覆盖原生实现"。
//
// 用法：pnpm vitest run scripts/es-polyfills.test.mjs

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const POLYFILL = "../public/es-polyfills.js";

// 原生实现先存起来，测完还回去（同一进程里还有别的测试文件，别把它们搞坏）。
const nativeWithResolvers = Promise.withResolvers;
const nativeAny = AbortSignal.any;

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

beforeAll(async () => {
  expect(typeof nativeWithResolvers).toBe("function"); // 本机应当有原生实现，否则这个测试没意义
  expect(typeof nativeAny).toBe("function");
});

afterAll(() => {
  Promise.withResolvers = nativeWithResolvers;
  AbortSignal.any = nativeAny;
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

// 判据：mermaid 渲染**串行 ＋ 按主题只初始化一次**（owner：「开发版没有错误，正式版有」✗ 的机理）。
//
// 这条钉的是**并发**：十几个图块同时 render 会把 mermaid 的模块级全局状态互相覆盖 ✗。
// 开发版因为模块实例化差异侥幸不炸 ✓ ⇒ 只有正式版会暴露 ✗ ⇒ 判据必须在**假件**上直接量并发行为 ✓。
import { describe, expect, it } from "vitest";
import { createMermaidGate } from "./mermaidGate";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mermaid 串行闸门", () => {
  it("★ 12 个并发 ⇒ 只 initialize 一次，且渲染**一个接一个**（不交叠）", async () => {
    const gate = createMermaidGate();
    const inits: string[] = [];
    const log: string[] = [];
    let running = 0;
    let maxConcurrent = 0;

    const jobs = Array.from({ length: 12 }, (_, i) =>
      gate.run(
        "default",
        (t) => inits.push(t),
        async () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          log.push(`start${i}`);
          await sleep(1);
          log.push(`end${i}`);
          running -= 1;
          return i;
        },
      ),
    );
    const out = await Promise.all(jobs);

    expect(inits).toEqual(["default"]); // 只初始化一次 ✓
    expect(maxConcurrent).toBe(1); // ⭐ 同一时刻只跑一个渲染 ✓（这就是修的那件事）
    expect(out).toEqual(Array.from({ length: 12 }, (_, i) => i)); // 结果按各自顺序返回 ✓
    // 严格交替：start/end 成对出现 ✓
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]).toBe(`start${i / 2}`);
      expect(log[i + 1]).toBe(`end${i / 2}`);
    }
  });

  it("主题变了 ⇒ 重新初始化一次（同主题绝不重复 ✓）", async () => {
    const gate = createMermaidGate();
    const inits: string[] = [];
    await gate.run("default", (t) => inits.push(t), async () => 1);
    await gate.run("default", (t) => inits.push(t), async () => 2);
    await gate.run("dark", (t) => inits.push(t), async () => 3);
    await gate.run("dark", (t) => inits.push(t), async () => 4);
    expect(inits).toEqual(["default", "dark"]);
    expect(gate.readyTheme()).toBe("dark");
  });

  it("★ 一次失败**不许把队列卡死**（错误原样抛给调用方 ✓，后面的照跑 ✓）", async () => {
    const gate = createMermaidGate();
    const boom = gate.run("default", () => {}, async () => {
      throw new Error("渲染炸了");
    });
    await expect(boom).rejects.toThrow("渲染炸了");
    await expect(gate.run("default", () => {}, async () => "ok")).resolves.toBe("ok");
    expect(gate.pending()).toBe(0);
  });

  it("初始化抛错 ⇒ 同样不卡死后续（readyTheme 保持没成功那次的语义 ✓）", async () => {
    const gate = createMermaidGate();
    await expect(
      gate.run("default", () => {
        throw new Error("initialize 炸了");
      }, async () => 1),
    ).rejects.toThrow("initialize 炸了");
    await expect(gate.run("default", () => {}, async () => 2)).resolves.toBe(2);
  });
});

describe("渲染前让一帧给浏览器（owner：点复盘条目跳转卡死）", () => {
  it("★ 队列跑起来之前，**别的任务有机会先跑**（这就是「窗口还能点」的判据 ✓）", async () => {
    const gate = createMermaidGate();
    const order: string[] = [];
    // 先排两个渲染 ✓
    const a = gate.run("default", () => {}, async () => {
      order.push("render1");
      return 1;
    });
    const b = gate.run("default", () => {}, async () => {
      order.push("render2");
      return 2;
    });
    // ⭐ 同步注册一个"浏览器该干的活"（画一帧 / 处理输入 ✓）：它必须**先于第一次渲染**跑到 ✓
    setTimeout(() => order.push("browser-paint"), 0);
    await Promise.all([a, b]);
    expect(order[0]).toBe("browser-paint");
    expect(order).toEqual(["browser-paint", "render1", "render2"]);
  });
});
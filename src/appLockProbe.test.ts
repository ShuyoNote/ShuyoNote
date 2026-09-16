// 探针：加密已开启且处于锁定态时，App 到底渲染出什么？
// 目的不是"看看能不能跑"，而是钉住一个**用户看得见的结果**：应当出现锁定屏，
// 而不是崩溃屏。先跑它拿到事实，再决定改法。
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const calls = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock("./lib/api", () => ({
  api: new Proxy(
    {},
    {
      get: (_t, name: string) => {
        calls.names.push(name);
        if (name === "encryptionStatus") {
          return async () => ({ enabled: true, locked: true });
        }
        return async () => [];
      },
    },
  ),
}));

const { default: App } = await import("./App");

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let spy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  spy?.mockRestore();
  spy = null;
});

describe("加密锁定时的启动画面", () => {
  it("锁定态应渲染锁定屏，而不是崩掉", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const errors: string[] = [];
    spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    let thrown: unknown = null;
    try {
      flushSync(() => root!.render(React.createElement(App)));
    } catch (e) {
      thrown = e;
    }
    // 状态回执是异步的：等一轮微任务，让它进入"锁定"这一帧
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    try {
      flushSync(() => {});
    } catch (e) {
      thrown = thrown ?? e;
    }

    console.log("[probe] 调用过的 api：", [...new Set(calls.names)].join(", "));
    console.log("[probe] 抛出的错误：", thrown ? String(thrown) : "无");
    console.log("[probe] console.error：", errors.slice(0, 3).join(" | ") || "无");
    console.log("[probe] 锁定屏=", !!host.querySelector(".lock-screen"), "崩溃屏=", !!host.querySelector(".app-crash"));

    expect(thrown, "渲染不应抛错").toBeNull();
    expect(host.querySelector(".lock-screen"), "应出现锁定屏").not.toBeNull();
  });
});

// ⭐ P3-3a 第二小步（task-52）判据：dev 看门 hook 的时序（dev 条件 / 3s 防抖 / 只 console / 卸载清理）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCrdtShadowWatch, type CrdtShadowWatchDeps } from "./useCrdtShadowWatch";
import { emptyShadowRows } from "./crdtShadowScan";
import type { ShadowRowsResult } from "./crdtShadow";
import { useSpaceStore } from "../store/space";

function Probe({ pagesVersion, deps }: { pagesVersion: number; deps: CrdtShadowWatchDeps }) {
  useCrdtShadowWatch(pagesVersion, deps);
  return null;
}

describe("useCrdtShadowWatch：只在 dev 下防抖扫描一次", () => {
  let host: HTMLDivElement;
  let root: Root;
  let info: Mock<(message: string, data: ShadowRowsResult) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    info = vi.fn<(message: string, data: ShadowRowsResult) => void>();
    useSpaceStore.setState({ activeId: "sp-dev" });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    useSpaceStore.setState({ activeId: null });
  });

  const render = (pagesVersion: number, deps: CrdtShadowWatchDeps) => {
    // eslint-disable-next-line react/no-danger
    flushSync(() => root.render(<Probe pagesVersion={pagesVersion} deps={deps} />));
  };

  it("isDev=false ⇒ 3s 后也不扫、不 console（生产构建不执行）", async () => {
    const scan = vi.fn(async () => emptyShadowRows());
    render(0, { isDev: false, scan, consoleInfo: info });
    await vi.advanceTimersByTimeAsync(5000);
    expect(scan).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("dev 下：3s 内不扫；到点扫一次并只 console.info 计数", async () => {
    const summary = { ...emptyShadowRows(), total: 3, withState: 2, equal: 1, differ: 1, differPageIds: ["p2"] };
    const scan = vi.fn(async () => summary);
    render(0, { isDev: true, scan, consoleInfo: info });
    await vi.advanceTimersByTimeAsync(2999);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith("sp-dev");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain("[crdt-shadow]");
    expect(info.mock.calls[0][1]).toEqual(summary);
  });

  it("pagesVersion 变化会重排防抖（3s 内变两次只扫一次）", async () => {
    const scan = vi.fn(async () => emptyShadowRows());
    render(0, { isDev: true, scan, consoleInfo: info });
    await vi.advanceTimersByTimeAsync(2000);
    render(1, { isDev: true, scan, consoleInfo: info });
    await vi.advanceTimersByTimeAsync(2000); // 距第一次 4s，但距第二次只有 2s ⇒ 还不扫
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("卸载会清掉定时器（不扫、不 console）", async () => {
    const scan = vi.fn(async () => emptyShadowRows());
    render(0, { isDev: true, scan, consoleInfo: info });
    await vi.advanceTimersByTimeAsync(2000);
    flushSync(() => root.unmount());
    await vi.advanceTimersByTimeAsync(5000);
    expect(scan).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    // afterEach 再 unmount 会报错 ⇒ 这里补一个空 root 让清理路径无害。
    root = createRoot(document.createElement("div"));
  });

  it("扫描失败：只 console.info（含失败原因），不抛、不影响应用", async () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const scan = vi.fn(async () => {
      throw new Error("扫描炸了");
    });
    render(0, { isDev: true, scan }); // 用默认 console.info
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();
    const texts = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes("[crdt-shadow]"))).toBe(true);
    consoleSpy.mockRestore();
  });
});

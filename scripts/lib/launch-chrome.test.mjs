import { describe, expect, it, vi } from "vitest";
import { launchChrome } from "./launch-chrome.mjs";

// 为什么要测这个：它是**所有**真人浏览器验收（含 Pages 部署前的那一步）的入口，
// 而它存在的唯一理由是"启动偶发失败时要重试"。重试语义写错（例如不重试、或把最后一次的
// 错误吞掉）不会有任何提示——只会让门禁变成随机红，而随机红的门禁很快就会被忽略。
describe("launchChrome —— 启动失败要重试，最后失败要说清", () => {
  it("第一次就成功：只调一次，且带上两个标准开关", async () => {
    const launcher = vi.fn().mockResolvedValue({ ok: true });
    const browser = await launchChrome({ executablePath: "/x", launcher });
    expect(browser).toEqual({ ok: true });
    expect(launcher).toHaveBeenCalledTimes(1);
    const args = launcher.mock.calls[0][0].args;
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-dev-shm-usage");
    expect(launcher.mock.calls[0][0].timeout).toBe(60_000);
  });

  it("失败两次后成功：重试到成功为止（这正是 CI 上那类 flake 的解）", async () => {
    const launcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Timed out after 30000 ms while waiting for the WS endpoint URL"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ok: true });
    const browser = await launchChrome({ executablePath: "/x", launcher, tries: 3 });
    expect(browser).toEqual({ ok: true });
    expect(launcher).toHaveBeenCalledTimes(3);
  });

  it("全都失败：抛出的错误里要有**次数、超时与最后一次原因**（否则排查时只剩一句 TimeoutError）", async () => {
    const launcher = vi.fn().mockRejectedValue(new Error("Timed out after 30000 ms while waiting for the WS endpoint URL"));
    await expect(launchChrome({ executablePath: "/x", launcher, tries: 2, timeoutMs: 1000 })).rejects.toThrow(
      /Chrome 启动失败（已重试 2 次，每次超时 1 秒）.*Timed out after 30000 ms/,
    );
  });

  it("调用方可以再补自己的开关（不覆盖那两个标准开关）", async () => {
    const launcher = vi.fn().mockResolvedValue({ ok: true });
    await launchChrome({ executablePath: "/x", launcher, args: ["--disable-gpu"] });
    expect(launcher.mock.calls[0][0].args).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ]);
  });
});

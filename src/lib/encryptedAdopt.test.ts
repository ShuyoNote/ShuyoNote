import { describe, expect, it, vi } from "vitest";
import { adoptWithPassphrase, startEncryptedAdopt } from "./encryptedAdopt";

/**
 * ⭐ **2026-10-28（owner 选 A：加密空间「一次性口令接入」向导）** —— 判据：
 * ① 打开向导 ⇒ 问一次口令，**输入框是 password 档**（⛔ 口令不许明文摆屏幕上 ✗）；
 * ② 口令非空 ⇒ 调 `unlock_encryption`，成功后 toast 成功 **并重读读数**；
 * ③ 解锁失败 ⇒ toast 带**后端原文**、**不重读**（没接成就不给"像成功"的读数 ✗）；
 * ④ 空口令 ⇒ **不发请求**（用户一个字都没输 ≠ 口令不对）；
 * ⑤ `pendingAdopt=0` ⇒ 根本不打开向导（⛔ 不弹空框 ✗）。
 */
describe("加密空间：一次性口令接入向导", () => {
  it("打开向导：问一次口令，输入框是 password 档，标题带数量", () => {
    const prompt = vi.fn();
    startEncryptedAdopt(3, { prompt });
    expect(prompt).toHaveBeenCalledTimes(1);
    const opts = prompt.mock.calls[0][0];
    expect(opts.title).toContain("3");
    expect(opts.type).toBe("password");
    expect(typeof opts.onSubmit).toBe("function");
  });

  it("pendingAdopt=0 ⇒ 不打开向导（不弹空框）", () => {
    const prompt = vi.fn();
    startEncryptedAdopt(0, { prompt });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("口令非空 ⇒ 解锁 + 成功提示 + 重读读数", async () => {
    const unlock = vi.fn(async () => undefined);
    const notify = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const r = await adoptWithPassphrase("  my-pass  ", 2, { unlock, notify, refresh });
    expect(r).toBe("adopted");
    expect(unlock).toHaveBeenCalledWith("my-pass"); // 两端空白被剪掉 ✓
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("正在接入 2 个"), "success");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("解锁失败 ⇒ 如实带后端原文、且不重读（不给像成功的读数）", async () => {
    const unlock = vi.fn(async () => {
      throw new Error("打不开：口令不对，或者这把锁被改过 —— 内容没有被解开");
    });
    const notify = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const r = await adoptWithPassphrase("wrong", 1, { unlock, notify, refresh });
    expect(r).toBe("failed");
    expect(refresh).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("口令不对"), "error");
  });

  it("空口令 ⇒ 不发请求", async () => {
    const unlock = vi.fn(async () => undefined);
    const notify = vi.fn();
    const r = await adoptWithPassphrase("   ", 1, { unlock, notify });
    expect(r).toBe("failed");
    expect(unlock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("口令是空的"), "error");
  });

  it("重读失败不影响「已接入」这个结论", async () => {
    const unlock = vi.fn(async () => undefined);
    const notify = vi.fn();
    const refresh = vi.fn(async () => {
      throw new Error("读不到");
    });
    const r = await adoptWithPassphrase("pw", 1, { unlock, notify, refresh });
    expect(r).toBe("adopted");
    expect(refresh).toHaveBeenCalled();
  });
});

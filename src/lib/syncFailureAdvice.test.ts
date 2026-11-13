// U3 片 3 扩展判据：失败行建议（纯函数）＋ **与 Rust 自动重试标记逐条同源**。
//
// 钉三件事：
//   ① 身份类先判（"超时 + 401" 也算身份类；⛔ 不许当网络问题骗人自动重试）
//   ② 每条失败都有**一句人话**＋一个**已存在入口**（retry/diagnose/pair；⛔ 不出现设备号/内部标识）
//   ③ ⭐ **两侧标记同源**：本文件的 IDENTITY/TRANSIENT 必须与 `src-tauri/src/lan_state.rs`
//      的 `auto_retryable()` 逐条相同（改一边不改另一边 ⇒ 本判据红）
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  IDENTITY_MARKERS,
  syncFailureAdvice,
  TRANSIENT_MARKERS,
} from "./syncFailureAdvice";

describe("U3 · syncFailureAdvice（一句话＋动作）", () => {
  it("① 身份类先判：超时+401 仍是身份类（不自动重试、去配对）", () => {
    const a = syncFailureAdvice("请求超时；而且 401 没通过");
    expect(a.tone).toBe("identity");
    expect(a.retriable).toBe(false);
    expect(a.action).toBe("pair");
    expect(a.oneLiner).toContain("配对");
  });

  it("② 锁着/空间不匹配各自一句人话（都指向体检，⛔ 不让人反复重试）", () => {
    const locked = syncFailureAdvice("对端空间锁着：没通过");
    expect(locked.tone).toBe("locked");
    expect(locked.action).toBe("diagnose");
    expect(locked.oneLiner).toContain("解锁");

    const space = syncFailureAdvice("空间标识不匹配");
    expect(space.tone).toBe("space");
    expect(space.action).toBe("diagnose");
    expect(space.oneLiner).toContain("空间");
  });

  it("③ 网络类：可重试 ＋ 指向手动重试", () => {
    for (const m of ["connection refused", "error sending request", "超时", "连接被拒"]) {
      const a = syncFailureAdvice(m);
      expect(a.tone, m).toBe("network");
      expect(a.retriable, m).toBe(true);
      expect(a.action, m).toBe("retry");
    }
  });

  it("④ 未知原因：不猜可重试，先体检/复制诊断", () => {
    const a = syncFailureAdvice("某个没见过的错");
    expect(a.tone).toBe("unknown");
    expect(a.retriable).toBe(false);
    expect(a.action).toBe("diagnose");
  });

  it("⑤ 空/没失败 ⇒ 不给建议（避免编一句）", () => {
    expect(syncFailureAdvice("")).toEqual({ tone: "none", retriable: false, oneLiner: "", action: null });
    expect(syncFailureAdvice(null).tone).toBe("none");
  });

  it("⑥ ⛔ 建议文案里不出现裸设备号/内部标识", () => {
    const all = [
      syncFailureAdvice("401"),
      syncFailureAdvice("已被逐台解除"),
      syncFailureAdvice("锁着"),
      syncFailureAdvice("timeout"),
      syncFailureAdvice("未知"),
    ];
    for (const a of all) {
      expect(a.oneLiner).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(a.oneLiner).not.toContain("peer=");
    }
  });
});

describe("U3 · 与 Rust auto_retryable 标记同源", () => {
  const rs = readFileSync(resolve(__dirname, "../../src-tauri/src/lan_state.rs"), "utf8");

  const arrayOf = (name: string): string[] => {
    const m = rs.match(new RegExp(`const ${name}: \\[&str; \\d+\\] = \\[([\\s\\S]*?)\\];`));
    expect(m, `没在 lan_state.rs 里找到 const ${name}`).toBeTruthy();
    return [...(m as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };

  it("⑦ IDENTITY 标记逐条一致（顺序也一致）", () => {
    expect([...IDENTITY_MARKERS]).toEqual(arrayOf("IDENTITY"));
  });

  it("⑧ TRANSIENT 标记逐条一致（顺序也一致）", () => {
    expect([...TRANSIENT_MARKERS]).toEqual(arrayOf("TRANSIENT"));
  });
});

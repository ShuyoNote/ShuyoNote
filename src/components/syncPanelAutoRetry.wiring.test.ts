// U3 片 2/3 接线判据（owner 2026-11-12 拍 ①A/③A）—— 源码级。
//
// 钉两件事（都能被一次"顺手改"打红）：
//   ① 后端读数必须上抛到界面骨架（TS 类型里的 `autoRetryStopped` / `autoRetryStreak`）；
//   ② 界面必须**如实显示**「自动重试已停止」并指向**已有**手动入口（⛔ 不许新造按钮/新同步路；
//      ⛔ 不许写成 Markdown 星号那类原样文字）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
const commands = readFileSync(resolve(__dirname, "..", "lib", "platform", "commands.ts"), "utf8");

describe("U3 · 自动重试停止的读数与显示", () => {
  it("① 读数上抛：TS 类型必须有 autoRetryStopped / autoRetryStreak", () => {
    expect(commands).toContain("autoRetryStopped");
    expect(commands).toContain("autoRetryStreak");
  });

  it("② 界面：停止标记必须存在，且指向已有手动入口（⛔ 新按钮）", () => {
    expect(panel).toContain('data-testid="auto-retry-stopped"');
    expect(panel).toContain("autoRetryStopped");
    // 指向既有入口（不是新造一个"重试"按钮）
    expect(panel).toMatch(/auto-retry-stopped[\s\S]{0,400}(立即同步|全部空间立即同步)/);
    // ⛔ 纯文本里不许出现 Markdown 星号（那会原样显示）
    expect(panel).not.toMatch(/auto-retry-stopped[\s\S]{0,200}\*\*/);
  });
});

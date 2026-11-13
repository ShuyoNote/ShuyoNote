// U3 片 3 扩展接线判据（源码级）：失败行「一句话＋已有入口」。
//
// 钉四件事：
//   ① 失败行**真的**用纯函数 `syncFailureAdvice` 算建议（⛔ 界面不许散写分类）；
//   ② 建议上屏（`data-testid="sync-history-advice"`），成功行不给建议；
//   ③ 动作只映射到**已有入口**：重试=既有 `retryMeshHistory`／体检=既有 `setMeshDiagnoseOpen`／
//      去配对=滚到既有 `invite-pairing`（⛔ 不新造命令/新同步路）；
//   ④ 复制诊断仍是既有 `copyHistoryDiagnostics`。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");

describe("U3 · 失败行建议接线", () => {
  it("① 建议来自纯函数（唯一实现），失败行才算", () => {
    expect(panel).toContain('from "../lib/syncFailureAdvice"');
    expect(panel).toMatch(/const advice = !h\.ok \? syncFailureAdvice\(h\.message\) : null;/);
  });

  it("② 建议上屏（有 testid），且只对失败行渲染", () => {
    expect(panel).toContain('data-testid="sync-history-advice"');
    expect(panel).toMatch(/!h\.ok && advice && advice\.oneLiner/);
  });

  it("③ 动作映射到已有入口（不新造命令/同步路）", () => {
    // pair ⇒ 滚到已有「邀请与配对」区
    expect(panel).toMatch(/advice\?\.action === "pair"[\s\S]{0,700}data-testid="invite-pairing"/);
    // diagnose ⇒ 打开已有连接体检
    expect(panel).toMatch(/advice\?\.action === "diagnose"[\s\S]{0,500}setMeshDiagnoseOpen\(true\)/);
    // retry ⇒ 既有 retryMeshHistory（旧按钮保留，语义不变）
    expect(panel).toContain("retryMeshHistory(i, h)");
    // 复制诊断 ⇒ 既有函数
    expect(panel).toContain("copyHistoryDiagnostics(h)");
  });

  it("④ ⛔ 没在这段里新造 invoke/命令", () => {
    const adviceBlock = panel.slice(panel.indexOf('data-testid="sync-history-advice"'));
    const tail = adviceBlock.slice(0, 2600);
    expect(tail).not.toContain("__TAURI_INTERNALS__");
    expect(tail).not.toMatch(/invoke\("/);
  });
});


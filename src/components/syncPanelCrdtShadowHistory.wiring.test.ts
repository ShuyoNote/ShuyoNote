// ⭐ task-67：SyncPanel「影子观测」只读行 —— 接线判据。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/SyncPanel.tsx", "utf8");
const history = readFileSync("src/lib/crdtShadowHistory.ts", "utf8");

describe("SyncPanel · 影子观测（只读）", () => {
  it("① 行在「同步核心」下方；只桌面；只读文案＋可选复制摘要", () => {
    const coreAt = panel.indexOf('data-testid="sync-core-status"');
    const historyAt = panel.indexOf('data-testid="crdt-shadow-history"');
    expect(coreAt).toBeGreaterThan(-1);
    expect(historyAt).toBeGreaterThan(coreAt);
    expect(panel).toContain('data-testid="crdt-shadow-history-text"');
    expect(panel).toContain('data-testid="crdt-shadow-history-copy"');
    expect(panel).toContain("影子观测");
    expect(
      panel.slice(Math.max(0, historyAt - 400), historyAt),
    ).toContain("isDesktopPlatform");
  });

  it("② 读历史走纯函数 + localStorage 键；坏历史 ⇒ unknown 而不是无记录", () => {
    expect(panel).toContain("SHADOW_HISTORY_KEY");
    expect(panel).toContain("parseShadowHistory");
    expect(panel).toContain("summarizeShadowHistory");
    expect(panel).toContain('r === "历史不是合法 JSON"');
    expect(panel).toContain('r === "历史不是数组"');
    expect(panel).toContain("summarizeShadowHistory(null)");
    expect(history).toContain('"未知（历史读不出来或格式坏了）"');
  });

  it("③ 复制摘要只走脱敏实现；⛔ 不提供清除/修复/自动改数据", () => {
    const copy = panel.slice(panel.indexOf("const copyShadowHistory"), panel.indexOf("const copyShadowHistory") + 900);
    expect(copy).toContain("shadowHistoryCopyText");
    expect(copy).toContain("不含正文/内部标识");
    const row = panel.slice(
      panel.indexOf('data-testid="crdt-shadow-history"'),
      panel.indexOf('data-testid="crdt-shadow-diagnose-row"'),
    );
    for (const forbidden of [
      "setItem",
      "removeItem",
      "shadowScanSpace(",
      "crdt-shadow-run",
      "crdt-shadow-copy",
    ]) {
      expect(row, `⛔ 只读行不许 ${forbidden}`).not.toContain(forbidden);
    }
    expect(history).toContain("不碰 localStorage");
  });
});

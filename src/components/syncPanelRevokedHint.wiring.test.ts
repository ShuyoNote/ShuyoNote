// U2 C3/C4 接线判据（owner 2026-11-12 ②A/③A）—— 源码级，不起宿主。
//
// 钉两件事（都能被一次"顺手改"打红）：
//   ① 二次确认必须把**做不到的事**说全：已同步副本删不掉 / 本机无法远程擦除 / 要重新配对
//      （⛔ 不许只说"不删你数据" —— 那是"我们这一侧"，不是对方那台）。
//   ② 被移出/没配对必须**如实说**，且必须走唯一实现 `../lib/peerRemovedHint`
//      （⛔ 不许在组件里散写"同步失败"；⛔ 不许出现裸设备号）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
const helper = readFileSync(resolve(__dirname, "..", "lib", "peerRemovedHint.ts"), "utf8");

/** 取两个标记之间那一段（找不到 ⇒ 抛；⛔ 不许"没找到当通过"）。 */
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  expect(i, `找不到起始标记：${start}`).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(end, i + start.length);
  expect(j, `找不到结束标记：${end}`).toBeGreaterThan(i);
  return text.slice(i, j);
}

const confirmBlock = () => between(panel, "const ok = await confirmDialog({", "if (!ok) return;");

describe("U2 · 撤销设备的界面口径", () => {
  it("① 二次确认把「做不到的」说全（副本删不掉 / 无法远程擦除 / 要重新配对）", () => {
    const block = confirmBlock();
    // ⚠️ 只判**那句 message**（块里的注释允许有 Markdown 强调；确认框里不许有）
    const m = block.match(/message:\s*"([^"]*)"/);
    expect(m, "找不到 confirmDialog 的 message").not.toBeNull();
    const message = m![1];
    expect(message).toContain("副本删不掉");
    expect(message).toContain("远程擦除");
    expect(message).toContain("重新配对");
    // ⛔ 确认框是纯文本：出现 Markdown 星号会被原样显示
    expect(message).not.toContain("**");
  });

  it("② 被移出/没配对：走唯一实现，且落点有 data-testid（⛔ 不在组件里散写文案）", () => {
    expect(panel).toContain('from "../lib/peerRemovedHint"');
    expect(panel).toContain("findPeerRemovedHint(");
    expect(panel).toContain('data-testid="peer-removed-hint"');
    // 文案本体在 lib 里，且明确区分两种处境
    expect(helper).toContain("PEER_REMOVED_HINT");
    expect(helper).toContain("PEER_NOT_PAIRED_HINT");
    expect(helper).toContain("没有登记过这台设备的公钥");
  });

  it("③ ⛔ 界面不许把「被移出」混成一句「同步失败」", () => {
    // 提示文案里必须给可执行下一步（重新邀请/配对），而不是只说失败
    expect(panel).not.toMatch(/peer-removed-hint[\s\S]{0,120}同步失败/);
    expect(helper).toContain("重新邀请");
  });
});

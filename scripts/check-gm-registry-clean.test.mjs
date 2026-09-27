// 为什么有它（2026-09-27）：`check-gm-registry-clean` 在**读不到共享 registry** 时**不判红**
// （干净机器 / 还没 fetch 过 registry 都会走到那里）—— 这是有意的（判红会逼人在无依赖机器上红）。
// 但那种"没查"**必须可见**：报告 `report-core.mjs` 的 `extractSkips()` 只认**行首**的
// `⏭` / `!` / `✗ skip` / `SKIP`；不带前缀 ⇒ 采集不到 ⇒ 这一格在报告里是**静默绿**。
// ⚠️ "没查却显示绿"正是隔壁 `check-sys-deps` 明写反对的形状（它的注释原话：
//    「不能当成"没 dpkg 所以跳过"，那正是"没查却显示绿"」）。
// ⇒ 本文件把「未实查必须走自报跳过通道」变成**会红的判据**。
import { describe, it, expect } from "vitest";
import { decideFromState } from "./check-gm-registry-clean.mjs";
import { extractSkips } from "./lib/report-core.mjs";

const STATE = { ok: false, reason: "registry 里没有 SQLCipher 源码", message: "（读不到）" };

describe("check-gm-registry-clean：没查就必须看得见", () => {
  it("读不到 registry ⇒ 仍然不判红（设计如此），但第一行以 `! ` 开头", () => {
    const r = decideFromState(STATE);
    expect(r.code).toBe(0);
    expect(r.lines[0].startsWith("! ")).toBe(true);
  });

  it("★ 关键：那一行**进得了**自报跳过通道（`extractSkips` 采集得到）", () => {
    const r = decideFromState(STATE);
    const skips = extractSkips(r.lines.join("\n"));
    expect(skips.length).toBe(1);
    expect(skips[0]).toContain("未实查");
  });

  it("反事实：去掉 `! ` 前缀 ⇒ 采集不到（说明这个前缀**就是**判据本身）", () => {
    const r = decideFromState(STATE);
    expect(extractSkips(r.lines[0].replace(/^! /, "")).length).toBe(0);
  });

  it("读到 registry 的正常分支不受影响（不产生跳过）", () => {
    const r = decideFromState({ ok: true, version: "0.38.2", srcDir: "/x", patched: false, pageCipher: null }, { platform: "linux" });
    expect(r.lines[0].startsWith("! ")).toBe(false);
    expect(extractSkips(r.lines.join("\n")).length).toBe(0);
  });
});
